import { render } from "preact";
import "./index.css";
import "./styles/views.css";
import { App } from "./app.tsx";
import { writeAppManifest } from "./lib/appManifest";
import { BUS_VERSION } from "./lib/sharedBus";
import { getVersion as getMistlibVersion } from "./vendor/mistlib/wrappers/web/index.js";

void getMistlibVersion()
  .then((version) => console.log(`[tc-lingo] mistlib ${version}`))
  .catch((error) => console.warn("[tc-lingo] failed to read mistlib version", error));

render(<App />, document.getElementById("app")!);

writeAppManifest({
  app: "tc-lingo",
  busVersion: BUS_VERSION,
  publishes: [],
  consumes: ["lingo-card-inbox"],
  reads: [],
});
