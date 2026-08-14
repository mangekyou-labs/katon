package main

import (
	"encoding/json"
	"flag"
	"strings"
	"time"

	"extension-scaffold/tools/pkg/configs"
	"extension-scaffold/tools/pkg/fccutils"
	"extension-scaffold/tools/pkg/support"
	instrutils "extension-scaffold/tools/pkg/utils"

	"github.com/ethereum/go-ethereum/common"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	"github.com/pkg/errors"
)

// Golden SwapRoute hash from services/fcc-matcher and SwapRouteHashVector.t.sol.
const goldenRouteHash = "0x72661810cd0161f16bf2e4335a226171bd4eb6e6386058108dbb43e118acd975"

// Expected response shapes for the scaffold's Hello World operations.
//
// These are deliberately declared here rather than imported from the extension:
// this tool asserts on the *wire format*, and must run unchanged against every
// language implementation (see docs/extension-contract.md). Keeping them local
// is what lets tools/ stay independent of any one implementation.

type sayHelloResponse struct {
	Greeting       string `json:"greeting"`
	GreetingNumber int    `json:"greetingNumber"`
}

type sayGoodbyeResponse struct {
	Farewell       string `json:"farewell"`
	FarewellNumber int    `json:"farewellNumber"`
}

func main() {
	af := flag.String("a", configs.AddressesFile, "file with deployed addresses")
	cf := flag.String("c", configs.ChainNodeURL, "chain node url")
	pf := flag.String("p", configs.ExtensionProxyURL, "extension proxy url")
	instructionSenderF := flag.String("instructionSender", "", "instructionSender address")
	flag.Parse()

	instructionSenderAddress := common.HexToAddress(*instructionSenderF)

	testSupport, err := support.DefaultSupport(*af, *cf)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	// --- Generic: configure contract -----------------------------------------
	logger.Infof("Setting extension ID on instruction sender...")
	err = instrutils.SetExtensionId(testSupport, instructionSenderAddress)
	if err != nil {
		if strings.Contains(err.Error(), "already set") || strings.Contains(err.Error(), "Extension ID already set") {
			logger.Infof("Extension ID already set on contract, continuing")
		} else {
			logger.Errorf("setExtensionId failed: %s", err)
			fccutils.FatalWithCause(errors.Errorf(
				"setExtensionId failed — is the extension registered? Check that pre-build.sh completed successfully. Error: %s", err))
		}
	}

	// --- Test case 1: Send a SAY_HELLO instruction ---
	logger.Infof("Sending SAY_HELLO instruction...")

	payload, err := json.Marshal(map[string]interface{}{
		"name": "World",
	})
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	instructionId, _, err := instrutils.SendSayHello(testSupport, instructionSenderAddress, payload)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Instruction sent. ID: %s", instructionId.Hex())

	time.Sleep(5 * time.Second)

	err = verifyHelloResult(*pf, instructionId)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Test passed: SAY_HELLO instruction processed successfully")

	// --- Test case 2: Send a SAY_GOODBYE instruction ---
	logger.Infof("Sending SAY_GOODBYE instruction...")

	goodbyeInstructionId, _, err := instrutils.SendSayGoodbye(testSupport, instructionSenderAddress, "World", "heading out")
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Instruction sent. ID: %s", goodbyeInstructionId.Hex())

	time.Sleep(5 * time.Second)

	err = verifyGoodbyeResult(*pf, goodbyeInstructionId)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Test passed: SAY_GOODBYE instruction processed successfully")

	// --- Test case 3–5: confidential auction matcher (golden vector) ---
	logger.Infof("Sending RFQ/CREATE instruction...")
	rfqID, _, err := instrutils.SendRFQCreate(testSupport, instructionSenderAddress, marshalJSON(goldenAuction()))
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Instruction sent. ID: %s", rfqID.Hex())
	time.Sleep(5 * time.Second)
	if err := verifyAcceptedJSON(*pf, rfqID, "RFQ/CREATE"); err != nil {
		fccutils.FatalWithCause(err)
	}

	logger.Infof("Sending BID/SUBMIT instruction...")
	bidID, _, err := instrutils.SendBidSubmit(testSupport, instructionSenderAddress, marshalJSON(goldenBid()))
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Instruction sent. ID: %s", bidID.Hex())
	time.Sleep(5 * time.Second)
	if err := verifyAcceptedJSON(*pf, bidID, "BID/SUBMIT"); err != nil {
		fccutils.FatalWithCause(err)
	}

	logger.Infof("Sending MATCH/FINALIZE instruction...")
	matchPayload := map[string]interface{}{
		"auction":   goldenAuction(),
		"bids":      []map[string]interface{}{goldenBid()},
		"now":       1000,
		"routePlan": goldenRoutePlan(),
	}
	matchID, _, err := instrutils.SendMatchFinalize(testSupport, instructionSenderAddress, marshalJSON(matchPayload))
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Instruction sent. ID: %s", matchID.Hex())
	time.Sleep(5 * time.Second)
	if err := verifyGoldenRoute(*pf, matchID); err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Test passed: MATCH/FINALIZE returned golden route hash")

	logger.Infof("All tests passed.")
}

func marshalJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	return b
}

func goldenAuction() map[string]interface{} {
	return map[string]interface{}{
		"commitment":       "0x0000000000000000000000000000000000000000000000000000000000000011",
		"chainId":          114,
		"router":           "0x00000000000000000000000000000000000000aa",
		"sellToken":        "0x0000000000000000000000000000000000000010",
		"buyToken":         "0x0000000000000000000000000000000000000020",
		"sellAmount":       "100000000000000000000",
		"minOutput":        "95000000000000000000",
		"decisionDeadline": 2000,
	}
}

func goldenRoutePlan() map[string]interface{} {
	return map[string]interface{}{
		"chainId":                    114,
		"router":                     "0x00000000000000000000000000000000000000aa",
		"commitment":                 "0x0000000000000000000000000000000000000000000000000000000000000011",
		"fccActionId":                "0x0000000000000000000000000000000000000000000000000000000000000022",
		"decisionBlock":              "1234567",
		"decisionBlockHash":          "0x0000000000000000000000000000000000000000000000000000000000000033",
		"deadline":                   "2000000000",
		"seller":                     "0x00000000000000000000000000000000000000c1",
		"recipient":                  "0x00000000000000000000000000000000000000c2",
		"sellToken":                  "0x0000000000000000000000000000000000000010",
		"buyToken":                   "0x0000000000000000000000000000000000000020",
		"sellAmount":                 "100000000000000000000",
		"minOutput":                  "95000000000000000000",
		"protocolFeeBps":             50,
		"eligibilityPolicyId":        "0x0000000000000000000000000000000000000000000000000000000000000044",
		"eligibilityRevocationEpoch": "0",
		"eligibilityRole":            "1",
		"eligibilityIssuerReference": "0x0000000000000000000000000000000000000000000000000000000000000055",
		"legs": []map[string]interface{}{{
			"source":     "0x00000000000000000000000000000000000000b1",
			"sellAmount": "100000000000000000000",
			"minOutput":  "95000000000000000000",
			"sourceData": "0x010203",
		}},
	}
}

func goldenBid() map[string]interface{} {
	return map[string]interface{}{
		"commitment":   "0x0000000000000000000000000000000000000000000000000000000000000099",
		"bidder":       "0x00000000000000000000000000000000000000b1",
		"sellToken":    "0x0000000000000000000000000000000000000010",
		"buyToken":     "0x0000000000000000000000000000000000000020",
		"sellAmount":   "100000000000000000000",
		"quotedOutput": "95000000000000000000",
		"sequence":     "1",
		"expiresAt":    2100,
	}
}

func verifyHelloResult(proxyURL string, instructionId common.Hash) error {
	// --- Generic: poll proxy for result (do not modify) ---
	actionResponse, err := fccutils.ActionResult(proxyURL, instructionId)
	if err != nil {
		return err
	}
	actionResult := actionResponse.Result

	if actionResult.Status == 0 {
		return errors.Errorf("instruction processing failed: %s", actionResult.Log)
	}
	if actionResult.Status == 2 {
		return errors.New("instruction still pending after polling, expected completed")
	}

	if len(actionResult.Data) == 0 {
		return errors.New("expected response data but got none")
	}

	var resp sayHelloResponse
	err = json.Unmarshal(actionResult.Data, &resp)
	if err != nil {
		return errors.Errorf("failed to unmarshal response: %s", err)
	}

	if resp.Greeting == "" {
		return errors.New("expected non-empty Greeting")
	}
	if resp.GreetingNumber < 1 {
		return errors.Errorf("expected GreetingNumber >= 1, got %d", resp.GreetingNumber)
	}

	logger.Infof("Response data: %+v", resp)

	return nil
}

func verifyGoodbyeResult(proxyURL string, instructionId common.Hash) error {
	actionResponse, err := fccutils.ActionResult(proxyURL, instructionId)
	if err != nil {
		return err
	}
	actionResult := actionResponse.Result

	if actionResult.Status == 0 {
		return errors.Errorf("instruction processing failed: %s", actionResult.Log)
	}
	if actionResult.Status == 2 {
		return errors.New("instruction still pending after polling, expected completed")
	}

	if len(actionResult.Data) == 0 {
		return errors.New("expected response data but got none")
	}

	var resp sayGoodbyeResponse
	err = json.Unmarshal(actionResult.Data, &resp)
	if err != nil {
		return errors.Errorf("failed to unmarshal response: %s", err)
	}

	if resp.Farewell == "" {
		return errors.New("expected non-empty Farewell")
	}
	if resp.FarewellNumber < 1 {
		return errors.Errorf("expected FarewellNumber >= 1, got %d", resp.FarewellNumber)
	}

	logger.Infof("Response data: %+v", resp)

	return nil
}

func verifyAcceptedJSON(proxyURL string, instructionId common.Hash, label string) error {
	actionResponse, err := fccutils.ActionResult(proxyURL, instructionId)
	if err != nil {
		return err
	}
	actionResult := actionResponse.Result
	if actionResult.Status == 0 {
		return errors.Errorf("%s failed: %s", label, actionResult.Log)
	}
	if actionResult.Status == 2 {
		return errors.Errorf("%s still pending after polling", label)
	}
	var resp struct {
		Accepted bool `json:"accepted"`
	}
	if err := json.Unmarshal(actionResult.Data, &resp); err != nil {
		return errors.Errorf("%s unmarshal: %s", label, err)
	}
	if !resp.Accepted {
		return errors.Errorf("%s expected accepted=true", label)
	}
	logger.Infof("%s accepted", label)
	return nil
}

func verifyGoldenRoute(proxyURL string, instructionId common.Hash) error {
	actionResponse, err := fccutils.ActionResult(proxyURL, instructionId)
	if err != nil {
		return err
	}
	actionResult := actionResponse.Result
	if actionResult.Status == 0 {
		return errors.Errorf("MATCH/FINALIZE failed: %s", actionResult.Log)
	}
	if actionResult.Status == 2 {
		return errors.New("MATCH/FINALIZE still pending after polling")
	}
	got := common.BytesToHash(actionResult.Data).Hex()
	if got != goldenRouteHash {
		return errors.Errorf("route hash mismatch: got %s want %s", got, goldenRouteHash)
	}
	logger.Infof("MATCH/FINALIZE route hash %s", got)
	return nil
}
