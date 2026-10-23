// The production Settings > Computer use page over a stand-in desktop bridge.
import { params } from "./bridge";
import { createRoot } from "react-dom/client";
import { useThisComputer, type ThisComputerHost } from "@opengeni/react/this-computer";
import { ComputerUseRoute } from "@/routes/computer-use";
import { DesktopContext } from "./host";
import "../../../src/styles.css";
import "@opengeni/react/this-computer.css";

const bridge = (
  window as unknown as {
    opengeniDesktop: { thisComputer: Omit<ThisComputerHost, "platform" | "productName"> };
  }
).opengeniDesktop;
const host: ThisComputerHost = {
  platform: "macos",
  productName: "Opengeni",
  ...bridge.thisComputer,
};

document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
document.documentElement.dataset.ogTheme = params.get("theme") === "dark" ? "dark" : "light";

function Preview() {
  const computer = useThisComputer(host, "workspace");
  return (
    <DesktopContext.Provider value={computer}>
      <ComputerUseRoute />
    </DesktopContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
