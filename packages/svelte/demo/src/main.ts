import "@opengeni/ui/compiled.css";
import { mount } from "svelte";
import App from "./App.svelte";
import "./demo.css";

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app");
mount(App, { target });
