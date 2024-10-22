import { XMLParser } from "fast-xml-parser";
import * as fs from "fs";
import fetch from "node-fetch";
import * as path from "path";
import * as unzip from "unzip-stream";
import { commands, Uri, window, workspace } from "vscode";
import { AsyncItem, AsyncTreeDataProvider } from "./asyncTree";
import { delay, getConfig } from "./utils";

type SnarfSitePackageItem = {
  "@_category": string;
  "@_name": string;
  "@_version": string;
  description: string;
  entry: { "@_url": string };
};

const parser = new XMLParser({ ignoreAttributes: false });

export class SnarfDataProvider extends AsyncTreeDataProvider {
  private makeItem(x: SnarfSitePackageItem): { category: string; item: AsyncItem } {
    const item = new AsyncItem({
      label: x["@_name"],
      tooltip: x.description,
      description: x["@_version"],
      iconId: "package",
      item: x,
      contextValue: "project",
    });
    return { category: x["@_category"], item };
  }

  private async fetchSite(url: string): Promise<{ label: string; packages: SnarfSitePackageItem[] }> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to snarf ${url}. Check the URL and your internet connection.`);

    const content = await resp.text();
    const xml = parser.parse(content);

    return {
      label: xml.snarf_site["@_name"],
      packages: Array.isArray(xml.snarf_site.package)
        ? xml.snarf_site.package
        : xml.snarf_site.package
        ? [xml.snarf_site.package]
        : [],
    };
  }

  async fetchData() {
    const { snarfURLs } = getConfig();
    if (!snarfURLs) return;

    const sites = await Promise.all(snarfURLs.map(this.fetchSite));

    return sites.map(({ label, packages }) => {
      const items = packages.map(this.makeItem).reduce<{ [key: string]: AsyncItem[] }>((acc, { category, item }) => {
        if (!acc.hasOwnProperty(category)) acc[category] = [];
        acc[category].push(item);
        return acc;
      }, {});

      const children = Object.entries(items).map(([label, children]) => {
        return new AsyncItem({
          label,
          iconId: "folder",
          children: children.sort((a, b) => a.label.localeCompare(b.label)),
        });
      });

      return new AsyncItem({ label, iconId: "project", children });
    });
  }

  beforeLoad() {
    commands.executeCommand("setContext", "web-CAT.snarfsErrored", false);
    commands.executeCommand("setContext", "web-CAT.snarfsLoaded", false);
  }

  afterLoad() {
    commands.executeCommand("setContext", "web-CAT.snarfsErrored", false);
    commands.executeCommand("setContext", "web-CAT.snarfsLoaded", true);
  }

  onLoadError(e: Error) {
    super.onLoadError(e);
    commands.executeCommand("setContext", "web-CAT.snarfsErrored", true);
  }
}

const downloadItem = async (pack: SnarfSitePackageItem) => {
  const dir = workspace.workspaceFolders?.[0].uri.fsPath;
  if (!dir) return window.showInformationMessage("Please open a folder first.");

  let resp = await fetch(pack.entry["@_url"]);
  const unzipPath = path.join(dir, pack["@_name"]);

  if (fs.existsSync(unzipPath)) {
    const ans = await window.showInformationMessage("Directory already exists. Overwrite?", "Yes", "No");
    if (ans !== "Yes") return;
  }
  else {
    fs.mkdirSync(unzipPath);
  }
  
  resp.body.pipe(unzip.Extract({ path: unzipPath }));

  try {
    await commands.executeCommand("java.project.import");
  } catch (e) {}

  return unzipPath;
};

const showSuccessMessage = async (pack: SnarfSitePackageItem, unzipPath: string) => {
  const selection = await window.showInformationMessage(`Succesfully snarfed ${pack["@_name"]}.`, "Open Folder");
  if (selection === "Open Folder") {
    await commands.executeCommand("vscode.openFolder", Uri.file(unzipPath));
  }
};

export const snarfItem = async (item: AsyncItem) => {
  const pack = <SnarfSitePackageItem>item.item;

  try {
    const [, unzipPath] = await window.withProgress(
      { location: { viewId: "snarferBrowser" }, title: "Snarfing..." },
      () => Promise.all([delay(1000), downloadItem(pack)])
    );
    if (!unzipPath) return;
    showSuccessMessage(pack, unzipPath);
  } catch (err) {
    // @ts-ignore
    window.showErrorMessage(`An error occurred: ${err?.message}`);
    console.error(err);
  }
};
