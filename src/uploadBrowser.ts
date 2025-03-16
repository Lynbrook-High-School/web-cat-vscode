import * as archiver from "archiver";
import { XMLParser } from "fast-xml-parser";
import * as glob from "glob";
import fetch from "node-fetch";
import { parse as parseHTML } from "node-html-parser";
import * as path from "path";
import * as streamBuffers from "stream-buffers";
import { promisify } from "util";
import { commands, ExtensionContext, InputBoxOptions, ViewColumn, window, workspace } from "vscode";
import { AsyncItem, AsyncTreeDataProvider } from "./asyncTree";
import { delay, getConfig } from "./utils";
import FormData = require("form-data");

type TransportParam = { name: string; value: string };
type Transport = { uri: string; params: TransportParam[]; fileParams: TransportParam[] };
type Exclude = { pattern: string };
type Assignment = { name: string; excludes: Exclude[]; transport: Transport };
type AssignmentGroup = { name: string; assignments: Assignment[] };
type SubmissionRoot = { excludes: Exclude[]; groups: AssignmentGroup[] };

type AssignmentItem = {
  assignment: Assignment;
  group: AssignmentGroup;
  root: SubmissionRoot;
  provider: UploadDataProvider;
};

const parser = new XMLParser({ ignoreAttributes: false, isArray: (_, __, ___, isAttribute) => !isAttribute });

const parseTransportParam = (value: any): TransportParam => {
  return {
    name: value["@_name"],
    value: value["@_value"],
  };
};

const parseTransport = (value: any): Transport => {
  return {
    uri: value["@_uri"],
    params: value["param"].map(parseTransportParam),
    fileParams: value["file-param"].map(parseTransportParam),
  };
};

const parseExclude = (value: any): Exclude => {
  return { pattern: value["@_pattern"] };
};

const parseAssignment = (value: any): Assignment => {
  return {
    name: value["@_name"],
    excludes: value["exclude"]?.map(parseExclude) ?? [],
    transport: parseTransport(value["transport"][0]),
  };
};

const parseAssignmentGroup = (value: any): AssignmentGroup => {
  return {
    name: value["@_name"],
    assignments: value["assignment"].map(parseAssignment),
  };
};

const parseSubmissionRoot = (value: any): SubmissionRoot => {
  console.log(value);
  return {
    excludes: value["submission-targets"][0]["exclude"].map(parseExclude),
    groups: value["submission-targets"][0]["assignment-group"].map(parseAssignmentGroup),
  };
};

export class UploadDataProvider extends AsyncTreeDataProvider {
  private async fetchSite(url: string): Promise<SubmissionRoot> {
    const resp = await fetch(url);
    const content = await resp.text();
    const xml = parser.parse(content);
    return parseSubmissionRoot(xml);
  }

  async fetchData() {
    const { submitURLs } = getConfig();
    if (!submitURLs) return;

    const roots = await Promise.all(submitURLs.map(this.fetchSite));

    return roots.flatMap((root) =>
      root.groups.map(
        (group) =>
          new AsyncItem({
            label: group.name,
            iconId: "project",
            children: group.assignments.map(
              (assignment) =>
                new AsyncItem({
                  label: assignment.name,
                  iconId: "package",
                  contextValue: "project",
                  item: {
                    assignment: { ...assignment, excludes: [...root.excludes, ...assignment.excludes] },
                    group,
                    root,
                    provider: this,
                  },
                })
            ),
          })
      )
    );
  }

  beforeLoad() {
    commands.executeCommand("setContext", "web-CAT.targetsErrored", false);
    commands.executeCommand("setContext", "web-CAT.targetsLoaded", false);
  }

  afterLoad() {
    commands.executeCommand("setContext", "web-CAT.targetsErrored", false);
    commands.executeCommand("setContext", "web-CAT.targetsLoaded", true);
  }

  onLoadError(e: Error) {
    super.onLoadError(e);
    commands.executeCommand("setContext", "web-CAT.targetsErrored", true);
  }
}

const PROMPT_ON: { [key: string]: InputBoxOptions } = {
  "${user}": { prompt: "Web-CAT Username" },
  "${pw}": { prompt: "Web-CAT Password", password: true },
  "${partners}": { prompt: "Partners" },
};

export const uploadItem = (item: AsyncItem, context: ExtensionContext) => {
  const { assignment: _assignment, group: _group, provider } = <AssignmentItem>item.item;

  const action = async () => {
    // Attempt to re-fetch assignment

    const groups = await provider.fetchData();
    const group = groups?.find((x) => x.label === _group.name);
    const { assignment } = <AssignmentItem>(group?.children?.find((x) => x.label === _assignment.name)?.item ?? item);

    // Prepare details

    const vars: Map<string, string> = new Map();
    const formatVars = (value: string) => {
      for (const [k, v] of vars.entries()) {
        value = value.replace(k, v);
      }
      return value;
    };

    const files: { param: TransportParam; dir: string }[] = [];

    for (const param of assignment.transport.fileParams) {
      const dirResult = await window.showOpenDialog({
        title: "Select Submission Folder",
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: workspace.workspaceFolders?.[0]?.uri,
        openLabel: `Select Folder (${param.name})`,
      });

      if (!dirResult) return window.showInformationMessage("Operation canceled.");
      files.push({ param, dir: dirResult[0].fsPath });
    }

    // Enter credentials

    const body = new FormData();

    for (const param of assignment.transport.params) {
      if (param.value === "${user}") {
        // Get username from settings instead of prompting
        const config = workspace.getConfiguration("web-CAT");
        let username = config.get<string>("username");
        
        // If not set, prompt once and save to settings
        if (!username) {
          username = await window.showInputBox({
            prompt: "Web-CAT Username",
          });
          if (!username) return window.showInformationMessage("Operation canceled.");
          await config.update("username", username, true);
        }
        
        vars.set(param.value, username);
        body.append(param.name, formatVars(username));
      } 
      else if (param.value === "${pw}") {
        // Get password from settings instead of prompting
        const config = workspace.getConfiguration("web-CAT");
        let password = config.get<string>("password");
        
        // If not set, prompt once and save to settings
        if (!password) {
          password = await window.showInputBox({
            prompt: "Web-CAT Password",
            password: true,
          });
          if (!password) return window.showInformationMessage("Operation canceled.");
          await config.update("password", password, true);
        }
        
        vars.set(param.value, password);
        body.append(param.name, formatVars(password));
      }
      else if (PROMPT_ON.hasOwnProperty(param.value)) {
        let value = vars.get(param.value);
        if (!value) {
          value = await window.showInputBox({
            ...PROMPT_ON[param.value],
            value: context.globalState.get(param.value),
          });
          if (!value) return window.showInformationMessage("Operation canceled.");
          await context.globalState.update(param.value, value);
          vars.set(param.value, value);
        }
        body.append(param.name, formatVars(param.value));
      } else {
        body.append(param.name, formatVars(param.value));
      }
    }

    // Make zip file

    for (const { param, dir } of files) {
      const output = new streamBuffers.WritableStreamBuffer();
      const archive = archiver("zip");
      archive.pipe(output);

      const paths = await promisify(glob)("**/*", {
        cwd: dir,
        ignore: [
          ...assignment.excludes.map((x) => x.pattern),
          "*.gdoc",
          "*.gslides",
          "*.gsheet",
          "*.gdraw",
          "*.gtable",
          "*.gform",
        ],
      });

      for (const file of paths) {
        archive.file(path.join(dir, file), { name: file });
      }

      archive.on("warning", (err) => {
        window.showWarningMessage(`An warning occurred: ${err?.message}`);
      });

      archive.on("error", (err) => {
        window.showErrorMessage(`An error occurred: ${err?.message}`);
      });

      await archive.finalize();
      body.append(param.name, output.getContents(), {
        filename: formatVars(param.value),
      });
    }

    const panel = window.createWebviewPanel("submissionResult", "Web-CAT Submission Results", ViewColumn.Two);
    panel.webview.html = `
    <!DOCTYPE html>
    <html>
      <head><title>Submitting to Web-CAT...</title></head>
      <body>${loadingBar}</body>
    </html>
    `;

    // Request

    const resp = await fetch(assignment.transport.uri, {
      method: "POST",
      body,
    });
    const html = await resp.text();
    const tree = parseHTML(html);
    const resultsUrl = tree.querySelector("a")?.attrs?.href;
    tree.querySelector("body").insertAdjacentHTML("afterbegin", loadingBar);
    panel.webview.html = tree.toString();

    // Fetch until results are there

    const resultsResp = await fetch(resultsUrl);
    const resultsHtml = await resultsResp.text();
    const resultsTree = parseHTML(resultsHtml);
    resultsTree.querySelector("body").insertAdjacentHTML("afterbegin", infoBox(resultsUrl));
    resultsTree.querySelector("body").insertAdjacentHTML("afterbegin", loadingBar);
    panel.webview.html = resultsTree.toString();

    for (let i = 0; i < 10; i++) {
      const resp = await fetch(resultsUrl);
      const html = await resp.text();
      if (!html.includes("Assignment Queued for Grading")) {
        const tree = parseHTML(html);
        tree.querySelector("body").insertAdjacentHTML("afterbegin", infoBox(resultsUrl));
        panel.webview.html = tree.toString();
        return;
      }
      await delay(500);
    }

    resultsTree.querySelector("body").removeChild(resultsTree.querySelector(".wc-vsc-slider"));
    panel.webview.html = resultsTree.toString();
  };

  try {
    window.withProgress({ location: { viewId: "uploadBrowser" }, title: "Uploading..." }, () =>
      Promise.all([delay(1000), action()])
    );
  } catch (err) {
    // @ts-ignore
    window.showErrorMessage(`An error occurred: ${err?.message}`);
    console.error(err);
  }
};

const infoBox = (url: string) => `
<div class="wc-vsc-info">
  <p>Showing Web-CAT results. <a href="${url}">Click here to open in browser.</a>
</div>
<style>
.wc-vsc-info {
  padding: 20px;
}
</style>
`;

const loadingBar = `
<div class="wc-vsc-slider">
  <div class="wc-vsc-line"></div>
  <div class="wc-vsc-subline wc-vsc-inc"></div>
  <div class="wc-vsc-subline wc-vsc-dec"></div>
</div>
<style>
  body {
    overflow-x: hidden;
  }
  .wc-vsc-slider {
    height: 5px;
    margin-bottom: 10px;
    overflow-x: hidden;
  }
  .wc-vsc-line {
    position: absolute;
    opacity: 0.4;
    background: #4a8df8;
    width: 150%;
    height: 5px;
  }
  .wc-vsc-subline {
    position: absolute;
    background: #4a8df8;
    height: 5px;
  }
  .wc-vsc-inc {
    animation: increase 2s infinite;
  }
  .wc-vsc-dec {
    animation: decrease 2s 0.5s infinite;
  }
  @keyframes increase {
    from {
      left: -5%;
      width: 5%;
    }
    to {
      left: 130%;
      width: 100%;
    }
  }
  @keyframes decrease {
    from {
      left: -80%;
      width: 80%;
    }
    to {
      left: 110%;
      width: 10%;
    }
  }
</style>
`;
