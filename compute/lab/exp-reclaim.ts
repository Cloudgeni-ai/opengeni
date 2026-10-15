// How much memory can an idle sandbox give back, and at what cost while it works?
// Compares guest kernel settings for returning freed memory to the host.
//
//   sudo bun exp-reclaim.ts <variant>
//
// Variants:
//   order9    free page reporting at the kernel default (2 MiB blocks only)
//   order0    report every free 4 KiB page
//   order3    report free blocks of 32 KiB and up
//   initfree  default reporting, guest zeroes pages on free (zswap stores zero pages for free)
//   order0-initfree
import { GUEST_DROP_CACHES, Vm, WORKLOAD, ensureCgroupRoot, record, sleep } from "./fc";

const BASE = "console=ttyS0 reboot=k panic=1 quiet loglevel=1";
const VARIANTS: Record<string, string> = {
  order9: BASE,
  order0: `${BASE} page_reporting.page_reporting_order=0`,
  order3: `${BASE} page_reporting.page_reporting_order=3`,
  initfree: `${BASE} init_on_free=1`,
  "order0-initfree": `${BASE} page_reporting.page_reporting_order=0 init_on_free=1`,
};

const variant = process.argv[2] ?? "order9";
const bootArgs = VARIANTS[variant];
if (!bootArgs) throw new Error(`unknown variant ${variant}`);
ensureCgroupRoot();

const vm = new Vm(`reclaim-${variant}`);
try {
  await vm.boot({ bootArgs });
  const w1 = await vm.exec(WORKLOAD);
  const w2 = await vm.exec(WORKLOAD); // second run: steady-state cost of reporting while busy
  const afterWorkload = vm.memory();
  await vm.exec(GUEST_DROP_CACHES);
  await sleep(10_000);
  const afterGuestReclaim = vm.memory();
  const order = (await vm.exec("cat /sys/module/page_reporting/parameters/page_reporting_order")).out.trim();
  const guestUsed = (await vm.exec("free -m | awk '/Mem:/ {print $3}'")).out.trim();
  await vm.pause();
  vm.reclaim("zswap");
  await sleep(1500);
  const inZswap = vm.memory();
  record("reclaim", {
    variant,
    order,
    guestUsedMiB: Number(guestUsed),
    workloadMs: [Math.round(w1.ms), Math.round(w2.ms)],
    afterWorkload,
    afterGuestReclaim,
    inZswap,
  });
} finally {
  await vm.destroy();
}
