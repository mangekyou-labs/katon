package extension

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"extension-scaffold/internal/config"
	"extension-scaffold/internal/matcher"

	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"
)

// --- TrustRFQ confidential auction matcher handlers ---

// The deterministic matching core is vendored in internal/matcher
// (verbatim from services/fcc-matcher). Handlers only decode, delegate,
// and update observable state. See docs/extension-contract.md.

// processRFQ routes RFQ instructions by OPCommand.
func (e *Extension) processRFQ(action teetypes.Action, df *instruction.DataFixed) (int, []byte) {
	switch {
	case df.OPCommand == teeutils.ToHash(config.OPCommandCreate):
		ar := e.processRFQCreate(action, df)
		b, _ := json.Marshal(ar)
		return http.StatusOK, b

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op command: received %s, expected [%s (%s)]",
			df.OPCommand.Hex(),
			teeutils.ToHash(config.OPCommandCreate).Hex(), config.OPCommandCreate,
		))
	}
}

// processRFQCreate validates a confidential RFQ create payload. In the
// single-machine Coston2 deployment the auction is accepted if it validates
// (persistent auction storage arrives with the indexer-backed relay).
func (e *Extension) processRFQCreate(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	var auction matcher.Auction
	if err := decodeStrict(df.OriginalMessage, &auction); err != nil || auction.Commitment == "" {
		return buildResult(action, df, nil, 0, errors.New("invalid RFQ create"))
	}

	e.mu.Lock()
	e.rfqCreateCount++
	e.lastRfqCommitment = auction.Commitment
	e.mu.Unlock()

	resp := struct {
		Commitment string `json:"commitment"`
		Accepted   bool   `json:"accepted"`
	}{Commitment: auction.Commitment, Accepted: true}
	data, _ := json.Marshal(resp)

	return buildResult(action, df, data, 1, nil)
}

// processBid routes BID instructions by OPCommand.
func (e *Extension) processBid(action teetypes.Action, df *instruction.DataFixed) (int, []byte) {
	switch {
	case df.OPCommand == teeutils.ToHash(config.OPCommandSubmit):
		ar := e.processBidSubmit(action, df)
		b, _ := json.Marshal(ar)
		return http.StatusOK, b

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op command: received %s, expected [%s (%s)]",
			df.OPCommand.Hex(),
			teeutils.ToHash(config.OPCommandSubmit).Hex(), config.OPCommandSubmit,
		))
	}
}

// processBidSubmit validates a confidential bid submission. Bids are stateless
// here: the auction-closed decision happens at MATCH/FINALIZE time from the
// FinalizeRequest the relay assembles.
func (e *Extension) processBidSubmit(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	var bid matcher.Bid
	if err := decodeStrict(df.OriginalMessage, &bid); err != nil || bid.Commitment == "" || bid.Bidder == "" {
		return buildResult(action, df, nil, 0, errors.New("invalid BID submit"))
	}

	e.mu.Lock()
	e.bidSubmitCount++
	e.lastBidCommitment = bid.Commitment
	e.mu.Unlock()

	resp := struct {
		Commitment string `json:"commitment"`
		Accepted   bool   `json:"accepted"`
	}{Commitment: bid.Commitment, Accepted: true}
	data, _ := json.Marshal(resp)

	return buildResult(action, df, data, 1, nil)
}
