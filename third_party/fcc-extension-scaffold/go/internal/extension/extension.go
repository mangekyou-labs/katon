package extension

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"

	"extension-scaffold/internal/config"
	"extension-scaffold/pkg/types"

	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	"github.com/flare-foundation/go-flare-common/pkg/tee/structs"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"

	"github.com/flare-foundation/tee-node/pkg/processorutils"
)

// MatcherState is the observable matcher portion of GET /state.
type MatcherState struct {
	RfqCreateCount    int    `json:"rfqCreateCount"`
	LastRfqCommitment string `json:"lastRfqCommitment"`
	BidSubmitCount    int    `json:"bidSubmitCount"`
	LastBidCommitment string `json:"lastBidCommitment"`
	MatchFinalizeCount int   `json:"matchFinalizeCount"`
	LastResultHash    string `json:"lastResultHash"`
}

type Extension struct {
	mu     sync.RWMutex
	Server *http.Server

	greetingCount int
	lastGreeting  string
	farewellCount int
	lastFarewell  string

	// TrustRFQ auction matcher state (see MatcherState).
	rfqCreateCount     int
	lastRfqCommitment  string
	bidSubmitCount     int
	lastBidCommitment  string
	matchFinalizeCount int
	lastResultHash     string
}

// currentState snapshots the matcher state under lock (used by tests and /state).
func (e *Extension) currentState() MatcherState {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return MatcherState{
		RfqCreateCount:     e.rfqCreateCount,
		LastRfqCommitment:  e.lastRfqCommitment,
		BidSubmitCount:     e.bidSubmitCount,
		LastBidCommitment:  e.lastBidCommitment,
		MatchFinalizeCount: e.matchFinalizeCount,
		LastResultHash:     e.lastResultHash,
	}
}


// --- DO NOT MODIFY: New(), actionHandler() are boilerplate.
func New(extensionPort, signPort int) *Extension {
	e := &Extension{}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /state", e.stateHandler)
	mux.HandleFunc("POST /action", e.actionHandler)

	e.Server = &http.Server{Addr: fmt.Sprintf(":%d", extensionPort), Handler: mux}
	return e
}

// stateHandler() structure is boilerplate but update the State field mapping to match your Extension fields.
func (e *Extension) stateHandler(w http.ResponseWriter, r *http.Request) {
	e.mu.RLock()
	state := e.currentState()
	stateResponse := types.StateResponse{
		StateVersion: teeutils.ToHash(config.Version),
		State: types.State{
			GreetingCount:      e.greetingCount,
			LastGreeting:       e.lastGreeting,
			FarewellCount:      e.farewellCount,
			LastFarewell:       e.lastFarewell,
			RfqCreateCount:     state.RfqCreateCount,
			LastRfqCommitment:  state.LastRfqCommitment,
			BidSubmitCount:     state.BidSubmitCount,
			LastBidCommitment:  state.LastBidCommitment,
			MatchFinalizeCount: state.MatchFinalizeCount,
			LastResultHash:     state.LastResultHash,
		},
	}
	e.mu.RUnlock()


	err := json.NewEncoder(w).Encode(stateResponse)
	if err != nil {
		http.Error(w, fmt.Sprintf("sending response: %v", err), http.StatusInternalServerError)
		return
	}
}

func (e *Extension) processAction(action teetypes.Action) (int, []byte) {
	dataFixed, err := processorutils.Parse[instruction.DataFixed](action.Data.Message)
	if err != nil {
		return http.StatusBadRequest, []byte(fmt.Sprintf("decoding fixed data: %v", err))
	}

	switch {
	case dataFixed.OPType == teeutils.ToHash(config.OPTypeGreeting):
		return e.processGreeting(action, dataFixed)

	case dataFixed.OPType == teeutils.ToHash(config.OPTypeRFQ):
		return e.processRFQ(action, dataFixed)

	case dataFixed.OPType == teeutils.ToHash(config.OPTypeBid):
		return e.processBid(action, dataFixed)

	case dataFixed.OPType == teeutils.ToHash(config.OPTypeMatch):
		return e.processMatch(action, dataFixed)

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op type: received %s, expected one of [%s (%s), %s (%s), %s (%s), %s (%s)]",
			dataFixed.OPType.Hex(),
			teeutils.ToHash(config.OPTypeGreeting).Hex(), config.OPTypeGreeting,
			teeutils.ToHash(config.OPTypeRFQ).Hex(), config.OPTypeRFQ,
			teeutils.ToHash(config.OPTypeBid).Hex(), config.OPTypeBid,
			teeutils.ToHash(config.OPTypeMatch).Hex(), config.OPTypeMatch,
		))
	}
}


// processGreeting routes GREETING instructions by OPCommand.
func (e *Extension) processGreeting(action teetypes.Action, df *instruction.DataFixed) (int, []byte) {
	switch {
	case df.OPCommand == teeutils.ToHash(config.OPCommandSayHello):
		ar := e.processSayHello(action, df)
		b, _ := json.Marshal(ar)
		return http.StatusOK, b

	case df.OPCommand == teeutils.ToHash(config.OPCommandSayGoodbye):
		ar := e.processSayGoodbye(action, df)
		b, _ := json.Marshal(ar)
		return http.StatusOK, b

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op command: received %s, expected one of [%s (%s), %s (%s)]",
			df.OPCommand.Hex(),
			teeutils.ToHash(config.OPCommandSayHello).Hex(), config.OPCommandSayHello,
			teeutils.ToHash(config.OPCommandSayGoodbye).Hex(), config.OPCommandSayGoodbye,
		))
	}
}

// processSayHello handles SAY_HELLO instructions: returns a greeting and tracks count.
func (e *Extension) processSayHello(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	var req types.SayHelloRequest
	dec := json.NewDecoder(bytes.NewReader(df.OriginalMessage))
	dec.DisallowUnknownFields()
	err := dec.Decode(&req)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding request: %w", err))
	}

	if req.Name == "" {
		return buildResult(action, df, nil, 0, fmt.Errorf("name must not be empty"))
	}

	e.mu.Lock()
	e.greetingCount++
	greetingNumber := e.greetingCount
	greeting := fmt.Sprintf("Hello, %s! Welcome to Flare Confidential Compute.", req.Name)
	e.lastGreeting = greeting
	e.mu.Unlock()

	resp := types.SayHelloResponse{
		Greeting:       greeting,
		GreetingNumber: greetingNumber,
	}
	data, _ := json.Marshal(resp)

	return buildResult(action, df, data, 1, nil)
}

// processSayGoodbye handles SAY_GOODBYE instructions: returns a farewell and tracks count.
func (e *Extension) processSayGoodbye(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	var req types.SayGoodbyeRequest
	err := structs.DecodeTo(types.SayGoodbyeMessageArg, df.OriginalMessage, &req)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding request: %w", err))
	}

	if req.Name == "" {
		return buildResult(action, df, nil, 0, fmt.Errorf("name must not be empty"))
	}

	e.mu.Lock()
	e.farewellCount++
	farewellNumber := e.farewellCount
	farewell := fmt.Sprintf("Goodbye, %s! Reason: %s", req.Name, req.Reason)
	e.lastFarewell = farewell
	e.mu.Unlock()

	resp := types.SayGoodbyeResponse{
		Farewell:       farewell,
		FarewellNumber: farewellNumber,
	}
	data, _ := json.Marshal(resp)

	return buildResult(action, df, data, 1, nil)
}
