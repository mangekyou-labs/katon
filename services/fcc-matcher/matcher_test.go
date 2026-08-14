package matcher

import "testing"

func TestCanonicalOrderMatchesTypeScriptVector(t *testing.T) {
	got, err := HashCanonicalOrder(CanonicalOrder{
		Maker:             "0x0000000000000000000000000000000000000001",
		Taker:             "0x0000000000000000000000000000000000000002",
		Executor:          "0x00000000000000000000000000000000000000bb",
		SellToken:         "0x0000000000000000000000000000000000000010",
		BuyToken:          "0x0000000000000000000000000000000000000020",
		SellAmount:        "1000000000000000000",
		MinBuyAmount:      "950000000000000000",
		Expiry:            "2000000000",
		Nonce:             "7",
		PairSalt:          "0x0000000000000000000000000000000000000000000000000000000000000042",
		ContextCommitment: "0x0000000000000000000000000000000000000000000000000000000000000043",
		OrderType:         0,
		FillMode:          0,
		FeeBps:            0,
	}, CanonicalDomain{
		Name:              "TrustRFQ",
		Version:           "1",
		ChainID:           114,
		VerifyingContract: "0x00000000000000000000000000000000000000aa",
	})
	if err != nil {
		t.Fatal(err)
	}
	const want = "0x14abeb3f994d71d79fe5f99fc15ee7b781c885e399427124da9a3da2cfe16572"
	if got != want {
		t.Fatalf("canonical hash mismatch: got %s want %s", got, want)
	}
}

func TestCanonicalOrderRejectsExpiryOutsideUint64(t *testing.T) {
	_, err := HashCanonicalOrder(CanonicalOrder{
		Maker:             "0x0000000000000000000000000000000000000001",
		Taker:             "0x0000000000000000000000000000000000000002",
		Executor:          "0x00000000000000000000000000000000000000bb",
		SellToken:         "0x0000000000000000000000000000000000000010",
		BuyToken:          "0x0000000000000000000000000000000000000020",
		SellAmount:        "1000000000000000000",
		MinBuyAmount:      "950000000000000000",
		Expiry:            "18446744073709551616",
		Nonce:             "7",
		PairSalt:          "0x0000000000000000000000000000000000000000000000000000000000000042",
		ContextCommitment: "0x0000000000000000000000000000000000000000000000000000000000000043",
	}, CanonicalDomain{
		Name:              "TrustRFQ",
		Version:           "1",
		ChainID:           114,
		VerifyingContract: "0x00000000000000000000000000000000000000aa",
	})
	if err == nil || err.Error() != "EXPIRY_WIDTH" {
		t.Fatalf("expected expiry width error, got %v", err)
	}
}

func testAuction() Auction {
	return Auction{
		Commitment:       "0x0000000000000000000000000000000000000000000000000000000000000011",
		ChainID:          114,
		Router:           "0x00000000000000000000000000000000000000aa",
		SellToken:        "0x0000000000000000000000000000000000000010",
		BuyToken:         "0x0000000000000000000000000000000000000020",
		SellAmount:       "100",
		MinOutput:        "90",
		DecisionDeadline: 2000,
	}
}

func testRoutePlan() SwapRoutePlan {
	return SwapRoutePlan{
		ChainID:                    114,
		Router:                     "0x00000000000000000000000000000000000000aa",
		Commitment:                 "0x0000000000000000000000000000000000000000000000000000000000000011",
		FccActionID:                "0x0000000000000000000000000000000000000000000000000000000000000022",
		DecisionBlock:              "1234567",
		DecisionBlockHash:          "0x0000000000000000000000000000000000000000000000000000000000000033",
		Deadline:                   "2000000000",
		Seller:                     "0x00000000000000000000000000000000000000c1",
		Recipient:                  "0x00000000000000000000000000000000000000c2",
		SellToken:                  "0x0000000000000000000000000000000000000010",
		BuyToken:                   "0x0000000000000000000000000000000000000020",
		SellAmount:                 "100",
		MinOutput:                  "90",
		ProtocolFeeBps:             50,
		EligibilityPolicyID:        "0x0000000000000000000000000000000000000000000000000000000000000044",
		EligibilityRevocationEpoch: "0",
		EligibilityRole:            "1",
		EligibilityIssuerReference: "0x0000000000000000000000000000000000000000000000000000000000000055",
		Legs: []SwapRouteLeg{{
			Source:     "0x00000000000000000000000000000000000000b1",
			SellAmount: "100",
			MinOutput:  "90",
			SourceData: "0x010203",
		}},
	}
}

func testBid(commitment, output, sequence string) Bid {
	return Bid{
		Commitment:   commitment,
		Bidder:       "lp-1",
		SellToken:    "0x0000000000000000000000000000000000000010",
		BuyToken:     "0x0000000000000000000000000000000000000020",
		SellAmount:   "100",
		QuotedOutput: output,
		Sequence:     sequence,
		ExpiresAt:    2100,
	}
}

func TestMatchIsIndependentOfArrivalOrder(t *testing.T) {
	auction := testAuction()
	first := []Bid{testBid("0xb", "100", "2"), testBid("0xa", "100", "1")}
	second := []Bid{testBid("0xa", "100", "1"), testBid("0xb", "100", "2")}
	left, err := MatchAuction(auction, first, 1000, testRoutePlan())
	if err != nil {
		t.Fatal(err)
	}
	right, err := MatchAuction(auction, second, 1000, testRoutePlan())
	if err != nil {
		t.Fatal(err)
	}
	if left.Winner.Commitment != "0xa" || right.Winner.Commitment != "0xa" {
		t.Fatalf("expected sequence-tie winner 0xa, got %s and %s", left.Winner.Commitment, right.Winner.Commitment)
	}
	if left.ResultHash != right.ResultHash {
		t.Fatalf("result hash order-dependent: %s vs %s", left.ResultHash, right.ResultHash)
	}
}

func TestMatchPrefersHigherOutputThenLowerSequence(t *testing.T) {
	auction := testAuction()
	result, err := MatchAuction(auction, []Bid{
		testBid("0xlow", "95", "1"),
		testBid("0xhigh", "110", "9"),
		testBid("0xtie", "110", "2"),
	}, 1000, testRoutePlan())
	if err != nil {
		t.Fatal(err)
	}
	if result.Winner.Commitment != "0xtie" {
		t.Fatalf("expected 0xtie winner, got %s", result.Winner.Commitment)
	}
}

func TestMatchRejectsClosedAuctionAndBadBids(t *testing.T) {
	auction := testAuction()
	if _, err := MatchAuction(auction, []Bid{testBid("0xa", "100", "1")}, 2001, testRoutePlan()); err != ErrAuctionClosed {
		t.Fatalf("expected closed, got %v", err)
	}
	badPair := testBid("0xa", "100", "1")
	badPair.SellToken = "OTHER"
	if _, err := MatchAuction(auction, []Bid{badPair}, 1000, testRoutePlan()); err != ErrBidPair {
		t.Fatalf("expected pair error, got %v", err)
	}
	if _, err := MatchAuction(auction, []Bid{testBid("0xa", "100", "1"), testBid("0xa", "100", "2")}, 1000, testRoutePlan()); err != ErrDuplicateBid {
		t.Fatalf("expected duplicate, got %v", err)
	}
}

func TestVerifyQuorumRequiresTwoOfThree(t *testing.T) {
	hash := "0xabc"
	_, err := VerifyQuorum([]TEEResult{
		{ResultHash: hash, TEEID: "t1", Attested: true},
	})
	if err != ErrQuorumUnavailable {
		t.Fatalf("expected quorum unavailable, got %v", err)
	}
	result, err := VerifyQuorum([]TEEResult{
		{ResultHash: hash, TEEID: "t1", Attested: true},
		{ResultHash: hash, TEEID: "t2", Attested: true},
		{ResultHash: "0xother", TEEID: "t3", Attested: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ResultHash != hash {
		t.Fatalf("unexpected hash %s", result.ResultHash)
	}
}

func TestHashSwapRouteMatchesSolidityGoldenVector(t *testing.T) {
	got, err := HashSwapRoute(SwapRoutePlan{
		ChainID:                    114,
		Router:                     "0x00000000000000000000000000000000000000aa",
		Commitment:                 "0x0000000000000000000000000000000000000000000000000000000000000011",
		FccActionID:                "0x0000000000000000000000000000000000000000000000000000000000000022",
		DecisionBlock:              "1234567",
		DecisionBlockHash:          "0x0000000000000000000000000000000000000000000000000000000000000033",
		Deadline:                   "2000000000",
		Seller:                     "0x00000000000000000000000000000000000000c1",
		Recipient:                  "0x00000000000000000000000000000000000000c2",
		SellToken:                  "0x0000000000000000000000000000000000000010",
		BuyToken:                   "0x0000000000000000000000000000000000000020",
		SellAmount:                 "100000000000000000000",
		MinOutput:                  "95000000000000000000",
		ProtocolFeeBps:             50,
		EligibilityPolicyID:        "0x0000000000000000000000000000000000000000000000000000000000000044",
		EligibilityRevocationEpoch: "0",
		EligibilityRole:            "1",
		EligibilityIssuerReference: "0x0000000000000000000000000000000000000000000000000000000000000055",
		Legs: []SwapRouteLeg{{
			Source:     "0x00000000000000000000000000000000000000b1",
			SellAmount: "100000000000000000000",
			MinOutput:  "95000000000000000000",
			SourceData: "0x010203",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	const want = "0x72661810cd0161f16bf2e4335a226171bd4eb6e6386058108dbb43e118acd975"
	if got != want {
		t.Fatalf("hashSwapRoute mismatch: got %s want %s", got, want)
	}
}

func TestMatchAuctionEmitsSwapRouteHash(t *testing.T) {
	plan := testRoutePlan()
	plan.SellAmount = "100000000000000000000"
	plan.MinOutput = "95000000000000000000"
	plan.Legs[0].SellAmount = "100000000000000000000"
	plan.Legs[0].MinOutput = "95000000000000000000"
	auction := testAuction()
	auction.SellAmount = plan.SellAmount
	auction.MinOutput = plan.MinOutput
	result, err := MatchAuction(auction, []Bid{{
		Commitment:   "0xa",
		Bidder:       "lp-1",
		SellToken:    auction.SellToken,
		BuyToken:     auction.BuyToken,
		SellAmount:   auction.SellAmount,
		QuotedOutput: plan.MinOutput,
		Sequence:     "1",
		ExpiresAt:    2100,
	}}, 1000, plan)
	if err != nil {
		t.Fatal(err)
	}
	const want = "0x72661810cd0161f16bf2e4335a226171bd4eb6e6386058108dbb43e118acd975"
	if result.ResultHash != want {
		t.Fatalf("resultHash mismatch: got %s want %s", result.ResultHash, want)
	}
}

func TestAllowedOperationsAreClosed(t *testing.T) {
	if !AllowedOperation(OpRFQ, CommandCreate) || AllowedOperation(OpRFQ, CommandSubmit) {
		t.Fatal("RFQ allowlist broken")
	}
	if !AllowedOperation(OpMatch, CommandFinalize) || AllowedOperation("UNKNOWN", CommandCreate) {
		t.Fatal("match allowlist broken")
	}
}
