// Package matcher is vendored VERBATIM from TrustRFQ services/fcc-matcher
// (matcher.go, route_hash.go, canonical.go) — the deterministic auction
// matching core. This copy exists because the scaffold Docker build context
// only includes go/{cmd,internal,pkg}. Keep in sync with services/fcc-matcher;
// the route-hash golden vector (0x72661810...) is the parity tripwire.
//
// bytes32Identifier is copied from services/fcc-matcher/scaffold_extension.go
// because the vendored matcher.go references it for its FccOp*/FccCommand*
// constants.
package matcher

import (
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

func bytes32Identifier(value string) string {
	encoded := make([]byte, 32)
	copy(encoded, []byte(value))
	return "0x" + fmt.Sprintf("%x", encoded)
}

// decodeHexBytes is exported for extension handlers that need to parse hex
// payloads — identical semantics to scaffold_extension.go decodeHexBytes.
func decodeHexBytes(value string) ([]byte, error) {
	trimmed := strings.TrimPrefix(value, "0x")
	if len(trimmed)%2 != 0 {
		return nil, errors.New("hex length")
	}
	return hex.DecodeString(trimmed)
}
