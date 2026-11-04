package spike

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
)

type Store struct{ Pool *db.Pool }

func (s *Store) Enabled() bool { return s != nil && s.Pool.Enabled() }

func (s *Store) Load(ctx context.Context, day string) (bool, []Trade, []Trade, []Bar, error) {
	open, closed, bars := []Trade{}, []Trade{}, []Bar{}
	if !s.Enabled() {
		return true, open, closed, bars, nil
	}
	enabled := true
	if err := s.Pool.QueryRow(ctx, `select paper_enabled from spike_control where id='current'`).Scan(&enabled); err != nil && !db.NoRows(err) {
		return false, nil, nil, nil, err
	}
	rows, err := s.Pool.Query(ctx, `select payload from spike_trades where status='open' or closed_day=$1 order by opened_at desc`, day)
	if err != nil {
		return false, nil, nil, nil, err
	}
	for rows.Next() {
		var raw []byte
		var trade Trade
		if err = rows.Scan(&raw); err == nil {
			err = json.Unmarshal(raw, &trade)
		}
		if err != nil {
			rows.Close()
			return false, nil, nil, nil, err
		}
		if trade.Status == "open" {
			trade.MarkStale = true
			open = append(open, trade)
		} else {
			closed = append(closed, trade)
		}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return false, nil, nil, nil, err
	}
	rows, err = s.Pool.Query(ctx, `select payload from spike_bars where day=$1 order by t`, day)
	if err != nil {
		return false, nil, nil, nil, err
	}
	for rows.Next() {
		var raw []byte
		var bar Bar
		if err = rows.Scan(&raw); err == nil {
			err = json.Unmarshal(raw, &bar)
		}
		if err != nil {
			rows.Close()
			return false, nil, nil, nil, err
		}
		bars = append(bars, bar)
	}
	rows.Close()
	return enabled, open, closed, bars, rows.Err()
}

func (s *Store) SaveBar(ctx context.Context, bar Bar) error {
	if !s.Enabled() {
		return nil
	}
	raw, err := json.Marshal(bar)
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx, `insert into spike_bars(symbol,day,t,payload) values($1,$2,$3,$4)
		on conflict(symbol,day,t) do update set payload=excluded.payload`, bar.Symbol, bar.Day, bar.T, raw)
	return err
}

func (s *Store) SaveBars(ctx context.Context, bars []Bar) error {
	if !s.Enabled() || len(bars) == 0 {
		return nil
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	for _, bar := range bars {
		raw, err := json.Marshal(bar)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `insert into spike_bars(symbol,day,t,payload) values($1,$2,$3,$4)
			on conflict(symbol,day,t) do update set payload=excluded.payload`, bar.Symbol, bar.Day, bar.T, raw); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) Insert(ctx context.Context, trade Trade) error {
	if !s.Enabled() {
		return fmt.Errorf("Spike paper persistence is unavailable")
	}
	raw, err := json.Marshal(trade)
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx, `insert into spike_trades(id,symbol,status,opened_at,payload) values($1,$2,'open',$3,$4)`,
		trade.ID, trade.Symbol, trade.OpenedAt, raw)
	return err
}

func (s *Store) Close(ctx context.Context, trade Trade) error {
	if !s.Enabled() {
		return fmt.Errorf("Spike paper persistence is unavailable")
	}
	raw, err := json.Marshal(trade)
	if err != nil {
		return err
	}
	result, err := s.Pool.Exec(ctx, `update spike_trades set status='closed',closed_at=$2,closed_day=$3,payload=$4 where id=$1 and status='open'`,
		trade.ID, trade.ClosedAt, dayKey(*trade.ClosedAt), raw)
	if err == nil && result.RowsAffected() != 1 {
		return fmt.Errorf("Spike paper trade is no longer open")
	}
	return err
}

func (s *Store) SetPaper(ctx context.Context, enabled bool) error {
	if !s.Enabled() {
		return fmt.Errorf("Spike paper persistence is unavailable")
	}
	_, err := s.Pool.Exec(ctx, `insert into spike_control(id,paper_enabled) values('current',$1)
		on conflict(id) do update set paper_enabled=excluded.paper_enabled,updated_at=now()`, enabled)
	return err
}
