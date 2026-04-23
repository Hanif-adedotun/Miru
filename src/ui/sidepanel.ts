import { initMiruApp } from "./app.js";

const root = document.getElementById("app");

if (!root) {
  throw new Error("Miru side panel root not found.");
}

initMiruApp(root);
