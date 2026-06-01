// gen_canonical_fixture: prints the canonical JSON of a fixed License
// using the production Go implementation. Output is consumed by the
// TypeScript test in test/canonical.test.ts to prove byte-for-byte
// equality across the Go and TS canonicalizers.
//
// Usage (from inside the Harmony-AIO repo, NOT meant to ship in the
// extracted worker repo):
//
//	cd c:\Dev\Harmony-AIO
//	go run ./external/harmony-license-worker/scripts/gen-canonical-fixture
//
// Writes to stdout. Re-run any time the License struct changes and
// paste the result into test/canonical.test.ts as EXPECTED_CANONICAL.
package main

import (
	"fmt"
	"os"
	"time"

	"github.com/professional-advantage/harmony-aio/internal/license"
)

func main() {
	issued := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	expires := time.Date(2026, 5, 31, 0, 0, 0, 0, time.UTC)
	l := license.License{
		Version:    1,
		LicenseKey: "HRM-PRO-PA00-DOGF-OOD1",
		InstanceID: "00000000-0000-4000-8000-000000000000",
		Tier:       license.TierProfessional,
		IssuedTo: license.IssuedTo{
			OrgName:      "Professional Advantage",
			ContactEmail: "beau@professionaladvantage.com",
		},
		IssuedAt:  issued,
		ExpiresAt: expires,
		Caps: license.Caps{
			MaxTenants:         100,
			MaxAgentsPerTenant: -1,
			MaxAgentsTotal:     -1,
			PackSize:           100,
		},
		Features: license.Features{
			SSO:               true,
			ImmutableLogs:     true,
			AutomaticFallback: true,
			PrioritySupport:   true,
			CustomProfiles:    true,
			PerTenantProfiles: true,
		},
		ProfilesAvailable: []string{"*"},
		Signature:         "ignored-by-canonical",
		SigningKeyID:      "v1",
	}

	canon, err := license.CanonicalJSON(l)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Stdout.Write(canon)
	os.Stdout.Write([]byte{'\n'})
}
