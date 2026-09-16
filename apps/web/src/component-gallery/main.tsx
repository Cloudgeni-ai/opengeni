import { createRoot } from "react-dom/client";
import { ComponentGallery } from "./app";
import "../styles.css";
import "../../../../packages/react/styles/connect.css";
import "./visual-directions.css";
createRoot(document.getElementById("root")!).render(<ComponentGallery />);
