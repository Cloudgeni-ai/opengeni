//! The kernel command line a VM boots with: the caller's, completed with
//! what every guest of this driver needs.

use super::balloon;
use crate::profile::PageSize;

/// Guest clock source that restore can correct.
///
/// A restored guest's clock otherwise stands still for as long as the VM was
/// saved. Firecracker fixes that on restore (`clock_realtime`) by moving the
/// paravirtual KVM clock forward, which only helps a guest that reads time from
/// that clock. Left to choose, Linux prefers the processor's own counter (TSC),
/// so boot pins it unless the caller already chose a clock source.
pub(super) const CLOCK_SOURCE: &str = "clocksource=kvm-clock";

/// What a guest's kernel is told of Firecracker's keyboard controller.
///
/// Firecracker emulates an i8042 only to take the guest's reboot (`reboot=k`
/// writes the reset command to its port) and to send ctrl-alt-del. It
/// acknowledges every command to the keyboard and answers none, so the
/// kernel's keyboard driver waits half a second for the identify command it
/// sends at boot, and every boot waits for its probes to settle before it
/// mounts the root filesystem. `i8042.dumbkbd` has the driver take the
/// keyboard as one it cannot command, so it sends none; `i8042.noaux` and
/// `i8042.nomux` skip probes for a mouse or a multiplexer there never is.
/// The guest's reboot does not go through the driver, and ctrl-alt-del
/// still arrives as a key press. Firecracker's own default command line
/// carries the same three, which any command line of the caller's replaces.
pub(super) const KEYBOARD: [&str; 3] = ["i8042.noaux", "i8042.nomux", "i8042.dumbkbd"];

/// The kernel command line to boot with: the caller's, plus [`CLOCK_SOURCE`]
/// if it names no clock source of its own, plus [`KEYBOARD`] if it names no
/// keyboard controller setting of its own, plus the
/// [`reporting_order`](balloon::reporting_order) for `reporting`, the pages
/// backing a guest that reports freed memory, if it names no order of its
/// own. A guest keeps the order it booted with.
pub(super) fn boot_args(requested: &str, reporting: Option<PageSize>) -> String {
    let names = |parameter: &str| {
        requested.split_whitespace().any(|arg| {
            arg.split_once('=')
                .is_some_and(|(name, _)| name == parameter)
        })
    };
    let keyboard = requested
        .split_whitespace()
        .any(|arg| arg.starts_with("i8042."));
    let mut args = requested.trim().to_owned();
    let mut add = |arg: &str| {
        if !args.is_empty() {
            args.push(' ');
        }
        args.push_str(arg);
    };
    if !names("clocksource") {
        add(CLOCK_SOURCE);
    }
    if !keyboard {
        for arg in KEYBOARD {
            add(arg);
        }
    }
    if let Some(pages) = reporting
        && !names(balloon::REPORTING_ORDER)
    {
        let order = balloon::reporting_order(pages);
        add(&format!("{}={order}", balloon::REPORTING_ORDER));
    }
    args
}
