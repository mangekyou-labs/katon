package matcher

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"sort"
	"strings"

	"golang.org/x/crypto/sha3"
)

var (
	ErrAuctionInput      = errors.New("AUCTION_INPUT")
	ErrBidInput          = errors.New("BID_INPUT")
	ErrAuctionClosed     = errors.New("AUCTION_CLOSED")
	ErrDuplicateBid      = errors.New("DUPLICATE_BID")
	ErrBidPair           = errors.New("BID_PAIR")
	ErrBidAmount         = errors.New("BID_AMOUNT")
	ErrNoRoute           = errors.New("NO_EXECUTABLE_ROUTE")
	ErrQuorumUnavailable = errors.New("QUORUM_UNAVAILABLE")
)

const (
	OpRFQ           = "RFQ"
	OpBid           = "BID"
	OpMatch         = "MATCH"
	OpLiquidation   = "LIQUIDATION"
	CommandCreate   = "CREATE"
	CommandCancel   = "CANCEL"
	CommandSubmit   = "SUBMIT"
	CommandStanding = "STANDING"
	CommandQuote    = "QUOTE"
	CommandFinalize = "FINALIZE"
)

var (
	FccOpRFQ           = bytes32Identifier(OpRFQ)
	FccOpBid           = bytes32Identifier(OpBid)
	FccOpMatch         = bytes32Identifier(OpMatch)
	FccOpLiquidation   = bytes32Identifier(OpLiquidation)
	FccCommandCreate   = bytes32Identifier(CommandCreate)
	FccCommandCancel   = bytes32Identifier(CommandCancel)
	FccCommandSubmit   = bytes32Identifier(CommandSubmit)
	FccCommandStanding = bytes32Identifier(CommandStanding)
	FccCommandQuote    = bytes32Identifier(CommandQuote)
	FccCommandFinalize = bytes32Identifier(CommandFinalize)
)

func AllowedOperation(opType, command string) bool {
	switch opType {
	case OpRFQ:
		return command == CommandCreate || command == CommandCancel
	case OpBid:
		return command == CommandSubmit || command == CommandStanding
	case OpMatch:
		return command == CommandQuote || command == CommandFinalize
	case OpLiquidation:
		return command == CommandCreate || command == CommandFinalize
	default:
		return false
	}
}

type Auction struct {
	Commitment       string `json:"commitment"`
	ChainID          uint64 `json:"chainId"`
	Router           string `json:"router"`
	SellToken        string `json:"sellToken"`
	BuyToken         string `json:"buyToken"`
	SellAmount       string `json:"sellAmount"`
	MinOutput        string `json:"minOutput"`
	DecisionDeadline int64  `json:"decisionDeadline"`
}

type Bid struct {
	Commitment   string `json:"commitment"`
	Bidder       string `json:"bidder"`
	SellToken    string `json:"sellToken"`
	BuyToken     string `json:"buyToken"`
	SellAmount   string `json:"sellAmount"`
	QuotedOutput string `json:"quotedOutput"`
	Sequence     string `json:"sequence"`
	ExpiresAt    int64  `json:"expiresAt"`
}

type MatchResult struct {
	Winner          Bid    `json:"winner"`
	ResultHash      string `json:"resultHash"`
	RouteCommitment string `json:"routeCommitment"`
}

type TEEResult struct {
	ResultHash string `json:"resultHash"`
	TEEID      string `json:"teeId"`
	Attested   bool   `json:"attested"`
}

type QuorumResult struct {
	ResultHash string
	Signers    []string
}

// FinalizeRequest is the confidential plaintext consumed by MATCH/FINALIZE.
// It deliberately contains no TEE or relay metadata; that remains in the
// authenticated outer envelope.
type FinalizeRequest struct {
	Auction   Auction        `json:"auction"`
	Bids      []Bid          `json:"bids"`
	Now       int64          `json:"now"`
	RoutePlan *SwapRoutePlan `json:"routePlan"`
}

func MatchAuction(auction Auction, bids []Bid, now int64, routePlan ...SwapRoutePlan) (MatchResult, error) {
	if err := validateAuction(auction); err != nil {
		return MatchResult{}, err
	}
	if now > auction.DecisionDeadline {
		return MatchResult{}, ErrAuctionClosed
	}
	auctionSell, err := decimalInt(auction.SellAmount)
	if err != nil {
		return MatchResult{}, ErrBidAmount
	}
	auctionMin, err := decimalInt(auction.MinOutput)
	if err != nil {
		return MatchResult{}, ErrNoRoute
	}
	seen := make(map[string]struct{}, len(bids))
	valid := make([]Bid, 0, len(bids))
	for _, bid := range bids {
		if bid.Commitment == "" || bid.Bidder == "" {
			return MatchResult{}, ErrBidInput
		}
		if _, exists := seen[bid.Commitment]; exists {
			return MatchResult{}, ErrDuplicateBid
		}
		seen[bid.Commitment] = struct{}{}
		if bid.SellToken != auction.SellToken || bid.BuyToken != auction.BuyToken {
			return MatchResult{}, ErrBidPair
		}
		bidSell, parseErr := decimalInt(bid.SellAmount)
		if parseErr != nil || bidSell.Cmp(auctionSell) != 0 {
			return MatchResult{}, ErrBidAmount
		}
		bidOutput, parseErr := decimalInt(bid.QuotedOutput)
		if parseErr != nil {
			return MatchResult{}, ErrBidInput
		}
		if _, parseErr := decimalInt(bid.Sequence); parseErr != nil {
			return MatchResult{}, ErrBidInput
		}
		if bid.ExpiresAt < now || bid.ExpiresAt < auction.DecisionDeadline || bidOutput.Cmp(auctionMin) < 0 {
			continue
		}
		valid = append(valid, bid)
	}
	if len(valid) == 0 {
		return MatchResult{}, ErrNoRoute
	}
	sort.SliceStable(valid, func(i, j int) bool {
		leftOutput, _ := decimalInt(valid[i].QuotedOutput)
		rightOutput, _ := decimalInt(valid[j].QuotedOutput)
		if leftOutput.Cmp(rightOutput) != 0 {
			return leftOutput.Cmp(rightOutput) > 0
		}
		leftSequence, _ := decimalInt(valid[i].Sequence)
		rightSequence, _ := decimalInt(valid[j].Sequence)
		if leftSequence.Cmp(rightSequence) != 0 {
			return leftSequence.Cmp(rightSequence) < 0
		}
		return valid[i].Commitment < valid[j].Commitment
	})
	winner := valid[0]
	if len(routePlan) == 0 {
		return MatchResult{}, errors.New("ROUTE_PLAN_REQUIRED")
	}
	plan := routePlan[0]
	if err := routeMatchesAuction(auction, plan); err != nil {
		return MatchResult{}, err
	}
	resultHash, err := HashSwapRoute(plan)
	if err != nil {
		return MatchResult{}, err
	}
	return MatchResult{
		Winner:          winner,
		ResultHash:      resultHash,
		RouteCommitment: auction.Commitment,
	}, nil
}

func routeMatchesAuction(auction Auction, plan SwapRoutePlan) error {
	if plan.ChainID != auction.ChainID ||
		!sameHex(plan.Router, auction.Router) ||
		!sameHex(plan.Commitment, auction.Commitment) ||
		!sameHex(plan.SellToken, auction.SellToken) ||
		!sameHex(plan.BuyToken, auction.BuyToken) ||
		plan.SellAmount != auction.SellAmount {
		return errors.New("ROUTE_PLAN_MISMATCH")
	}
	planMin, err := decimalInt(plan.MinOutput)
	if err != nil {
		return errors.New("ROUTE_PLAN_MISMATCH")
	}
	auctionMin, err := decimalInt(auction.MinOutput)
	if err != nil {
		return errors.New("ROUTE_PLAN_MISMATCH")
	}
	if planMin.Cmp(auctionMin) < 0 {
		return errors.New("ROUTE_PLAN_MISMATCH")
	}
	return nil
}

func sameHex(left, right string) bool {
	return strings.EqualFold(strings.TrimPrefix(left, "0x"), strings.TrimPrefix(right, "0x"))
}

func validateAuction(auction Auction) error {
	if auction.Commitment == "" || auction.ChainID == 0 || auction.Router == "" ||
		auction.SellToken == "" || auction.BuyToken == "" || auction.SellToken == auction.BuyToken ||
		auction.DecisionDeadline < 0 {
		return ErrAuctionInput
	}
	sellAmount, err := decimalInt(auction.SellAmount)
	if err != nil || sellAmount.Sign() <= 0 {
		return ErrAuctionInput
	}
	minimum, err := decimalInt(auction.MinOutput)
	if err != nil {
		return ErrAuctionInput
	}
	if minimum.Sign() < 0 {
		return ErrAuctionInput
	}
	return nil
}

func VerifyQuorum(results []TEEResult, thresholds ...int) (QuorumResult, error) {
	threshold := 2
	if len(thresholds) > 0 {
		threshold = thresholds[0]
	}
	if threshold != 2 {
		return QuorumResult{}, ErrQuorumUnavailable
	}
	groups := make(map[string][]string)
	seenTEE := make(map[string]struct{})
	for _, result := range results {
		if !result.Attested || result.ResultHash == "" || result.TEEID == "" {
			continue
		}
		if _, seen := seenTEE[result.TEEID]; seen {
			continue
		}
		seenTEE[result.TEEID] = struct{}{}
		groups[result.ResultHash] = append(groups[result.ResultHash], result.TEEID)
	}
	hashes := make([]string, 0, len(groups))
	for hash, signers := range groups {
		if len(signers) >= threshold {
			hashes = append(hashes, hash)
		}
	}
	if len(hashes) == 0 {
		return QuorumResult{}, ErrQuorumUnavailable
	}
	sort.Strings(hashes)
	signers := append([]string(nil), groups[hashes[0]]...)
	sort.Strings(signers)
	return QuorumResult{ResultHash: hashes[0], Signers: signers}, nil
}

func DecodeAuction(data []byte) (Auction, error) {
	if len(data) > 64*1024 {
		return Auction{}, errors.New("PAYLOAD_TOO_LARGE")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var auction Auction
	if err := decoder.Decode(&auction); err != nil {
		return Auction{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return Auction{}, errors.New("TRAILING_INPUT")
	}
	return auction, nil
}

func decimalInt(value string) (*big.Int, error) {
	if value == "" || value[0] == '-' {
		return nil, errors.New("INVALID_INTEGER")
	}
	result := new(big.Int)
	if _, ok := result.SetString(value, 10); !ok {
		return nil, errors.New("INVALID_INTEGER")
	}
	return result, nil
}

func keccakHex(data []byte) string {
	hash := sha3.NewLegacyKeccak256()
	_, _ = hash.Write(data)
	return "0x" + hex.EncodeToString(hash.Sum(nil))
}

// sha256Digest is kept for build/reproducibility diagnostics and does not
// enter route authorization. Route hashes use Ethereum legacy Keccak above.
func sha256Digest(data []byte) string {
	digest := sha256.Sum256(data)
	return "0x" + hex.EncodeToString(digest[:])
}
