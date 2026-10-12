"""Native epoch/index/replay rules. No command admission or provider proof."""
import subprocess
import unittest
import uuid

# Reuse the framing fixture; its tests are not imported for discovery here.
import test_broker_wire as wire

BINARY = str(wire.BUILD / "broker-input")


def request(index, epoch=1, kind="hello", **kwargs):
    fields = dict(sequence=str(index), epoch=str(epoch), kind=kind,
                  command="-", request=str(uuid.uuid4()))
    fields.update(kwargs)
    return wire.frame(**fields)


class BrokerInputTests(unittest.TestCase):
    def invoke(self, frames, expected, boundary=False):
        result = subprocess.run([BINARY, wire.BROKER, *(["near-index-exhaustion"] if boundary else [])],
                                input=b"".join(frames), capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        actual = [(kind, int(epoch), int(index)) for line in result.stdout.decode().splitlines()
                  for kind, epoch, index in [line.split("\t")]]
        self.assertEqual(actual, expected)

    def test_initial_fence_is_required_and_payload_cannot_hide_in_it(self):
        frames = [request(1), request(1, kind="fence", payload=b"not-empty"),
                  request(1, kind="fence", offset="1"),
                  request(1, kind="fence", command=wire.COMMAND), request(1, kind="fence")]
        self.invoke(frames, [("rejected", 0, 0)] * 4 + [("new", 1, 1)])

    def test_duplicate_last_body_replays_without_any_state_change(self):
        first = request(1, kind="fence")
        second = request(2, kind="prepare", payload=b"exact-body")
        self.invoke([first, first, second, second, second],
                    [("new", 1, 1), ("replay", 1, 1), ("new", 1, 2),
                     ("replay", 1, 2), ("replay", 1, 2)])

    def test_conflicting_same_index_reuse_is_not_a_replay(self):
        first = request(1, kind="fence")
        altered_id = first.replace(b"\tfence\t", b"\thello\t")
        self.invoke([first, request(1, kind="fence"), altered_id, first],
                    [("new", 1, 1), ("rejected", 1, 1), ("rejected", 1, 1), ("replay", 1, 1)])

    def test_gaps_old_indexes_and_stale_epochs_are_refused(self):
        first = request(1, kind="fence")
        self.invoke([first, request(3), request(2), first, request(3, epoch=2), request(3)],
                    [("new", 1, 1), ("rejected", 1, 1), ("new", 1, 2),
                     ("rejected", 1, 2), ("rejected", 1, 2), ("new", 1, 3)])

    def test_new_writer_requires_strictly_new_epoch_fence(self):
        fence = request(2, epoch=2, kind="fence")
        self.invoke([request(1, kind="fence"), request(2, kind="fence"), fence, fence,
                     request(3), request(3, epoch=2), request(4, epoch=1, kind="fence")],
                    [("new", 1, 1), ("rejected", 1, 1), ("new", 2, 2), ("replay", 2, 2),
                     ("rejected", 2, 2), ("new", 2, 3), ("rejected", 2, 3)])

    def test_invalid_frame_is_distinct_from_order_rejection_and_never_advances(self):
        # These independent reducer calls are not a production stream loop;
        # the eventual stream owner must poison input on the invalid result.
        self.invoke([b"invalid\n", request(1, kind="fence"), b"invalid\n", request(3)],
                    [("invalid", 0, 0), ("new", 1, 1), ("invalid", 1, 1), ("rejected", 1, 1)])

    def test_index_exhaustion_keeps_exact_last_replay_but_refuses_wrap_or_growth(self):
        final = request(0xffffffff)
        self.invoke([final, final, request(0x100000000), request(1, epoch=2, kind="fence")],
                    [("new", 1, 0xffffffff), ("replay", 1, 0xffffffff),
                     ("rejected", 1, 0xffffffff), ("rejected", 1, 0xffffffff)], boundary=True)


if __name__ == "__main__":
    unittest.main()
