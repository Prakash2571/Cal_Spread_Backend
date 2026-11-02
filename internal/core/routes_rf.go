package core

import (
	"context"
	"net/http"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	kjson "github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
)

type rfBody struct {
	Rf *float64 `json:"rf"`
}

// POST /api/rf (index.ts:1208), full admin: rf = Number(req.body?.rf), so numeric
// strings, null (0), booleans and one-element arrays are accepted; anything that is not
// finite is 400. The value is kept in memory at once and persisted in the background.
func (c *Core) setRf(w http.ResponseWriter, r *http.Request) {
	rf := jsNumber(bodyField(r, "rf"))
	if !jsx.Finite(rf) {
		httpx.Error(w, http.StatusBadRequest, "Provide a numeric rf (percent).")
		return
	}
	c.mu.Lock()
	c.rf = &rf
	c.mu.Unlock()
	if c.d.RfStore != nil {
		c.background(func(ctx context.Context) {
			if err := c.d.RfStore.SaveRfRate(ctx, rf); err != nil {
				c.logf("[rf] persist failed: %v", err)
			}
		})
	}
	httpx.JSON(w, http.StatusOK, rfBody{&rf})
}

// GET /api/rf/current (index.ts:1224): public; {rf: null} until an admin sets one.
func (c *Core) rfCurrent(w http.ResponseWriter, _ *http.Request) {
	httpx.JSON(w, http.StatusOK, rfBody{c.RfPct()})
}

// GET /api/rf (index.ts:1235): the same value behind TOKEN_ROUTE_SECRET; 409 until set.
func (c *Core) rfByPasscode(w http.ResponseWriter, r *http.Request) {
	if !c.checkTokenRoute(w, r) {
		return
	}
	rf := c.RfPct()
	if rf == nil {
		httpx.Error(w, http.StatusConflict, "No risk-free rate set yet. The admin must enter it in the panel first.")
		return
	}
	httpx.JSON(w, http.StatusOK, rfBody{rf})
}

// jsNumberString is String(n) for a number.
func jsNumberString(n float64) string { return kjson.FormatNumber(n) }
