import { createRoot } from "react-dom/client";
import { SettingsStudio } from "./settings-studio";
import "../styles.css";
import "../../../../packages/react/styles/connect.css";
import "./visual-directions.css";
import "./settings-document.css";
import "./settings-refinement.css";
createRoot(document.getElementById("root")!).render(<SettingsStudio />);
