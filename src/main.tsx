import { MistBuildBanner } from "./components/MistBuildBanner";
import { captureMistBuildInfo } from "./lib/mistBuildInfo";
import { render } from "preact";
import "./index.css";
import "./styles/views.css";
import { App } from "./app.tsx";
import { writeAppManifest } from "./lib/appManifest";
import { BUS_VERSION } from "./lib/sharedBus";
import { getVersion as getMistlibVersion } from "@tik-choco/mistlib-web";
import { takeVaultLink } from "./lib/vault/link";

void getMistlibVersion()
  .then((version) => { captureMistBuildInfo(); console.log(`[tc-lingo] mistlib ${version}`); })
  .catch((error) => console.warn("[tc-lingo] failed to read mistlib version", error));

const initialVaultCode = takeVaultLink();
render(<div class="mist-app-frame"><MistBuildBanner /><div class="mist-app-content"><App initialVaultCode={initialVaultCode} /></div></div>, document.getElementById("app")!);

writeAppManifest({
  app: "tc-lingo",
  busVersion: BUS_VERSION,
  publishes: [],
  consumes: ["lingo-card-inbox"],
  reads: [],
});
