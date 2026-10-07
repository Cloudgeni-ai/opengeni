#!/bin/bash
# Test both datetime backends (time and chrono)

set -e

echo "================================================================"
echo "Testing Datetime Backends: time-crate vs chrono-crate"
echo "================================================================"
echo ""

echo "=== Phase 1: Test with time-crate (default) ==="
echo "Running: cargo test --lib"
cargo test --lib --quiet
TIME_RESULT=$?

echo ""
echo "=== Phase 2: Test with chrono-crate ==="
echo "Running: cargo test --lib --no-default-features --features chrono-crate,ring,jetstream,kv,object-store,service"
cargo test --lib --no-default-features --features chrono-crate,ring,jetstream,kv,object-store,service --quiet
CHRONO_RESULT=$?

echo ""
echo "================================================================"
if [ $TIME_RESULT -eq 0 ] && [ $CHRONO_RESULT -eq 0 ]; then
    echo "✅ All tests passed with both datetime backends!"
    echo "   - time-crate: PASS"
    echo "   - chrono-crate: PASS"
else
    echo "❌ Some tests failed:"
    [ $TIME_RESULT -ne 0 ] && echo "   - time-crate: FAIL"
    [ $CHRONO_RESULT -ne 0 ] && echo "   - chrono-crate: FAIL"
    exit 1
fi
echo "================================================================"
