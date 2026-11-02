package fairvalue

import (
	"errors"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/model"
)

// WorkerStats is workers.ts stats().
type WorkerStats struct {
	Running  float64 `json:"running"`
	Queued   float64 `json:"queued"`
	Failures float64 `json:"failures"`
	Workers  float64 `json:"workers"`
}

// Workers is what the engine needs from the analytics worker pool. Tests substitute it.
type Workers interface {
	Surface(input *model.InputSnapshot) (*model.SurfaceSnapshot, error)
	Calculate(input *model.InputSnapshot, surface *model.SurfaceSnapshot, req model.CalculatorRequest) (*model.CalculatorResult, error)
	Independent(input *model.InputSnapshot, expiry string, strike float64) (*model.IndependentEstimate, error)
	Stats() WorkerStats
	Dispose()
}

// Job is one unit of analytics work. A model error is a panic (a TypeScript throw); the
// pool turns it into the job's error, as worker.ts turned exceptions into {ok:false}.
type Job func() any

var (
	errWorkersDisposed = errors.New("Analytics workers disabled/disposed.")
	errQueueFull       = errors.New("Analytics worker queue is full.")
	errWorkersStopped  = errors.New("Analytics workers stopped.")
	errTimeBudget      = errors.New("Analytics worker time budget exceeded.")
)

type jobResult struct {
	value any
	err   error
}

type poolJob struct {
	run     Job
	result  chan jobResult // buffered: settling never blocks
	settled bool
}

type poolSlot struct {
	job   *poolJob
	timer *time.Timer
	jobs  chan *poolJob
	gone  bool
}

// Pool is workers.ts AnalyticsWorkers: CPU analytics off the request paths, with a
// bounded queue, bounded concurrency and a wall-clock budget per job.
//
// Node killed a worker thread whose job overran its budget. A goroutine cannot be
// killed: an overrunning job is rejected at once, its slot is retired (a fresh one is
// started for the next job, as Node started a fresh worker) and its late result is
// dropped. Every loop in the model is bounded, so a retired goroutine always finishes.
// Node's 96 MB per-worker heap cap has no Go equivalent; inputs are bounded instead
// (max_tokens, 20,000 catalog rows).
type Pool struct {
	mu          sync.Mutex
	concurrency int
	maxQueue    int
	timeout     time.Duration
	slots       []*poolSlot
	queue       []*poolJob
	disposed    bool
	failures    int
}

// NewPool returns a pool with the configured limits (workers, max_queue,
// worker_timeout_ms).
func NewPool(concurrency, maxQueue int, timeout time.Duration) *Pool {
	return &Pool{concurrency: concurrency, maxQueue: maxQueue, timeout: timeout}
}

func newPoolFor(c model.Config) *Pool {
	return NewPool(int(c.Workers), int(c.MaxQueue), time.Duration(c.WorkerTimeoutMs)*time.Millisecond)
}

// Submit queues a job and waits for its result.
func (p *Pool) Submit(run Job) (any, error) {
	p.mu.Lock()
	if p.disposed {
		p.mu.Unlock()
		return nil, errWorkersDisposed
	}
	if len(p.queue) >= p.maxQueue {
		p.mu.Unlock()
		return nil, errQueueFull
	}
	job := &poolJob{run: run, result: make(chan jobResult, 1)}
	p.queue = append(p.queue, job)
	p.dispatchLocked()
	p.mu.Unlock()
	r := <-job.result
	return r.value, r.err
}

func (p *Pool) settleLocked(job *poolJob, value any, err error) {
	if job == nil || job.settled {
		return
	}
	job.settled = true
	job.result <- jobResult{value: value, err: err}
}

func (p *Pool) dispatchLocked() {
	if p.disposed {
		return
	}
	for len(p.queue) > 0 {
		var slot *poolSlot
		for _, s := range p.slots {
			if s.job == nil {
				slot = s
				break
			}
		}
		if slot == nil {
			if len(p.slots) >= p.concurrency {
				return
			}
			slot = p.newSlotLocked()
		}
		job := p.queue[0]
		p.queue = p.queue[1:]
		slot.job = job
		s := slot
		slot.timer = time.AfterFunc(p.timeout, func() { p.failSlot(s, job, errTimeBudget) })
		slot.jobs <- job
	}
}

func (p *Pool) newSlotLocked() *poolSlot {
	s := &poolSlot{jobs: make(chan *poolJob, 1)}
	p.slots = append(p.slots, s)
	go func() {
		for job := range s.jobs {
			value, err := runJob(job.run)
			p.finish(s, job, value, err)
		}
	}()
	return s
}

// runJob runs a job, turning a panic into its error (worker.ts: error.message ||
// "Analytics worker failed.").
func runJob(run Job) (value any, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = model.AsError(r)
			if err.Error() == "" {
				err = errors.New("Analytics worker failed.")
			}
		}
	}()
	return run(), nil
}

func (p *Pool) finish(s *poolSlot, job *poolJob, value any, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if s.gone || s.job != job {
		return // late result of a retired slot
	}
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	s.job = nil
	if err != nil {
		p.failures++
		p.settleLocked(job, nil, err)
	} else {
		p.settleLocked(job, value, nil)
	}
	p.dispatchLocked()
}

func (p *Pool) failSlot(s *poolSlot, job *poolJob, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	// Stopping a timer cannot retract a callback that already started. A slot
	// may have been reused since that callback began: only its original job
	// owns this deadline, never the next job dispatched on the same worker.
	if s.gone || s.job != job {
		return
	}
	s.gone = true
	p.failures++
	for i, x := range p.slots {
		if x == s {
			p.slots = append(p.slots[:i:i], p.slots[i+1:]...)
			break
		}
	}
	if s.timer != nil {
		s.timer.Stop()
	}
	p.settleLocked(s.job, nil, err)
	s.job = nil
	close(s.jobs)
	p.dispatchLocked()
}

// Stats reports running and queued jobs, failures and live worker slots.
func (p *Pool) Stats() WorkerStats {
	p.mu.Lock()
	defer p.mu.Unlock()
	running := 0
	for _, s := range p.slots {
		if s.job != nil {
			running++
		}
	}
	return WorkerStats{Running: float64(running), Queued: float64(len(p.queue)), Failures: float64(p.failures), Workers: float64(len(p.slots))}
}

// Dispose rejects queued and running jobs and retires every slot. A pool is single-use.
func (p *Pool) Dispose() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.disposed = true
	for _, job := range p.queue {
		p.settleLocked(job, nil, errWorkersStopped)
	}
	p.queue = nil
	for _, s := range p.slots {
		if s.timer != nil {
			s.timer.Stop()
		}
		p.settleLocked(s.job, nil, errWorkersStopped)
		s.job = nil
		s.gone = true
		close(s.jobs)
	}
	p.slots = nil
}

// Surface is workers.ts surface(): the listing catalog stays on the engine side.
func (p *Pool) Surface(input *model.InputSnapshot) (*model.SurfaceSnapshot, error) {
	captured := input.WithoutListingCatalog()
	v, err := p.Submit(func() any { s := model.BuildSurface(&captured); return &s })
	if err != nil {
		return nil, err
	}
	return v.(*model.SurfaceSnapshot), nil
}

// Calculate runs the calculator job.
func (p *Pool) Calculate(input *model.InputSnapshot, surface *model.SurfaceSnapshot, req model.CalculatorRequest) (*model.CalculatorResult, error) {
	v, err := p.Submit(func() any { r := model.Calculate(input, surface, req); return &r })
	if err != nil {
		return nil, err
	}
	return v.(*model.CalculatorResult), nil
}

// Independent runs the leave-one-strike-out job.
func (p *Pool) Independent(input *model.InputSnapshot, expiry string, strike float64) (*model.IndependentEstimate, error) {
	v, err := p.Submit(func() any { r := model.IndependentEstimateFor(input, expiry, strike); return &r })
	if err != nil {
		return nil, err
	}
	return v.(*model.IndependentEstimate), nil
}
