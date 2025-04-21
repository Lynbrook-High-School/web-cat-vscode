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
    let assignment = _assignment;
    try {
      const groups = await provider.fetchData();
      const group = groups?.find((x) => x.label === _group.name);
      if (group?.children) {
        const assignmentItem = group.children.find((x) => x.label === _assignment.name);
        if (assignmentItem?.item) {
          assignment = (<AssignmentItem>assignmentItem.item).assignment;
        }
      }
    } catch (error) {
      console.error("Failed to re-fetch assignment data, using original assignment", error);
    }

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
      if (PROMPT_ON.hasOwnProperty(param.value)) {
        let value = vars.get(param.value);
        if (!value) {
          value = await window.showInputBox({
            ...PROMPT_ON[param.value],
            value: context.globalState.get(param.value),
            ignoreFocusOut: true, // Keep dialog open when focus moves
          });
          if (!value) return window.showInformationMessage("Operation canceled.");
          await context.globalState.update(param.value, value);
          vars.set(param.value, value);
        }
      }

      body.append(param.name, formatVars(param.value));
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

    // Request - Simplified approach based on original implementation
    try {
      const resp = await fetch(assignment.transport.uri, {
        method: "POST",
        body,
      });
      
      const html = await resp.text();
      const tree = parseHTML(html);
      const resultsUrl = tree.querySelector("a")?.attrs?.href;
      
      console.log("Initial response, found link:", resultsUrl);
      
      if (!resultsUrl) {
        // If we can't find a URL, show the response as is
        panel.webview.html = createSimpleView(html, null, "Could not find results URL. Check your credentials.");
        return;
      }

      // Show initial response
      panel.webview.html = createSimpleView(html, resultsUrl);

      // Fetch results page
      const resultsResp = await fetch(resultsUrl);
      const resultsHtml = await resultsResp.text();
      panel.webview.html = createSimpleView(resultsHtml, resultsUrl);

      // Poll for completion
      for (let i = 0; i < 10; i++) {
        if (!resultsHtml.includes("Assignment Queued for Grading")) {
          break;
        }
        
        await delay(500);
        const resp = await fetch(resultsUrl);
        const html = await resp.text();
        
        if (!html.includes("Assignment Queued for Grading")) {
          panel.webview.html = createSimpleView(html, resultsUrl);
          return;
        }
      }
    } catch (error) {
      console.error("Error during submission:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      panel.webview.html = createSimpleView("", null, 
        `Error during submission: ${errorMessage}. Please check your connection and credentials.`);
    }
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

/**
 * Types for parsed Web-CAT results
 */
interface ScoreItem {
  label: string;
  score: string;
}

interface FileDetail {
  filename: string;
  autoComments: string;
  autoPoints: string;
  errorMessages?: string[]; // Added errorMessages field to store specific error comments
}

interface DownloadableFile {
  filename: string;
  description: string;
}

interface WebCATResults {
  title: string;
  assignment: string;
  student: string;
  submitted: string;
  totalScore: string;
  scoreBreakdown: ScoreItem[];
  fileDetails: FileDetail[];
  coverage: string;
  downloadables: DownloadableFile[];
  isQueued: boolean;
  errorMessages: string[]; // Added to collect all error messages across files
}

/**
 * Parse Web-CAT results HTML and extract structured information
 */
const parseWebCATResults = (html: string): WebCATResults | null => {
  if (!html) return null;
  
  try {
    const root = parseHTML(html);
    const results: WebCATResults = {
      title: '',
      assignment: '',
      student: '',
      submitted: '',
      totalScore: '',
      scoreBreakdown: [],
      fileDetails: [],
      coverage: '',
      downloadables: [],
      isQueued: html.includes("Assignment Queued for Grading"),
      errorMessages: [] // Initialize empty error messages array
    };
    
    // Extract page title
    const title = root.querySelector('.title h1');
    if (title) {
      results.title = title.text.trim();
    }

    // Extract assignment info
    const assignmentRow = root.querySelector('tr th.R:contains("Assignment")');
    if (assignmentRow) {
      results.assignment = assignmentRow.nextElementSibling?.text?.trim() || '';
    }
    
    // Extract student name
    const nameRow = root.querySelector('tr th.R:contains("Name")');
    if (nameRow) {
      results.student = nameRow.nextElementSibling?.text?.trim() || '';
    }
    
    // Extract submission time
    const submittedRow = root.querySelector('tr th.R:contains("Submitted")');
    if (submittedRow) {
      results.submitted = submittedRow.nextElementSibling?.text?.trim() || '';
    }
    
    // Extract total score
    const totalScoreRow = root.querySelector('tr th.R:contains("Total Score")');
    if (totalScoreRow) {
      results.totalScore = totalScoreRow.nextElementSibling?.text?.trim() || '0.0/0.0';
    }
    
    // Extract score breakdown - use a more reliable selector
    const scoreBreakdownSection = root.querySelectorAll('table.floatLeft'); 
    if (scoreBreakdownSection && scoreBreakdownSection.length >= 2) {
      const scoreRows = scoreBreakdownSection[1].querySelectorAll('tr');
      scoreRows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          const label = cells[0].text.trim();
          const score = cells[1].text.trim();
          if (label && score) {
            results.scoreBreakdown.push({ label, score });
          }
        }
      });
    }

    // Extract problem coverage and specific hints
    const coveragePane = root.querySelector('div[title*="Estimate of Problem Coverage"]');
    if (coveragePane) {
      const coverageValue = coveragePane.querySelector('b'); // First <b> usually has the percentage
      if (coverageValue) {
        results.coverage = coverageValue.text.trim();
      }
      
      // Check for compilation failure first
      const compileFailureText = 'Your code failed to compile correctly';
      const compileFailureParagraph = coveragePane.querySelector(`p:contains("${compileFailureText}")`);

      if (compileFailureParagraph) {
        // Extract messages related to compilation failure
        results.errorMessages.push(compileFailureText); // Add the main failure message
        let nextElement = compileFailureParagraph.nextElementSibling;
        while (nextElement && nextElement.tagName === 'P') {
          const text = nextElement.text.trim();
          if (text && !results.errorMessages.includes(text)) {
            results.errorMessages.push(text);
          }
          nextElement = nextElement.nextElementSibling;
        }
      } else {
        // If no compile failure, look for specific hints
        const hintTriggerParagraph = coveragePane.querySelector('p:contains("The following hint(s)")');
        if (hintTriggerParagraph) {
          let nextElement = hintTriggerParagraph.nextElementSibling;
          while (nextElement) {
            // Check if it's a list (UL)
            if (nextElement.tagName === 'UL') {
              const listItems = nextElement.querySelectorAll('li');
              listItems.forEach(li => {
                const pInLi = li.querySelector('p');
                const text = (pInLi || li).text.trim();
                if (text && !results.errorMessages.includes(text)) {
                  results.errorMessages.push(text);
                }
              });
            } 
            // Check if it's just a paragraph directly following
            else if (nextElement.tagName === 'P') {
               const text = nextElement.text.trim();
               if (text && !results.errorMessages.includes(text)) {
                  results.errorMessages.push(text);
               }
            }
            nextElement = nextElement.nextElementSibling;
          }
        } else {
           // Fallback: If neither compile error nor hints found, try common patterns
           const text = coveragePane.text.trim();
           const missingMethodRegex = /class\s+(\w+)\s+is\s+missing\s+method\s+(\w+)/gi;
           const matches = Array.from(text.matchAll(missingMethodRegex));
           
           if (matches.length > 0) {
             for (const match of matches) {
               const cleanMessage = match[0].trim();
               if (!results.errorMessages.includes(cleanMessage)) {
                 results.errorMessages.push(cleanMessage);
               }
             }
           }
        }
      }
    }

    // Also check for a separate "Compilation Produced Errors" pane
    const compileErrorPane = root.querySelector('div[title="Compilation Produced Errors"]');
    if (compileErrorPane) {
        const preElement = compileErrorPane.querySelector('pre');
        if (preElement) {
            const compileLog = preElement.text.trim();
            // Add a concise version or key lines from the compile log
            const lines = compileLog.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('/*') && !l.startsWith('^')); // Basic filtering
            lines.forEach(line => {
                const cleanLine = line.replace(/<[^>]*>/g, '').trim(); // Remove potential HTML tags if any
                if (cleanLine && !results.errorMessages.some(msg => msg.includes(cleanLine))) {
                    results.errorMessages.push(`Compile Error: ${cleanLine}`);
                }
            });
        }
    }
    
    // Extract file details and error messages
    const fileRows = root.querySelectorAll('div[title="File Details"] table tbody tr');
    if (fileRows) {
      fileRows.forEach(row => {
        if (row.classList.contains('o') || row.classList.contains('e')) {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 3) {
            const filename = row.querySelector('td:first-child')?.text?.trim() || '';
            const autoComments = cells[cells.length - 2]?.text?.trim() || '0';
            const autoPoints = cells[cells.length - 1]?.text?.trim() || '0.0';
            
            // Extract file-specific error messages by looking for the file link
            const fileLink = row.querySelector('td:first-child a');
            const errorMessages: string[] = [];
            
            if (filename) {
              // Create file detail entry
              const fileDetail: FileDetail = {
                filename,
                autoComments,
                autoPoints,
                errorMessages: []
              };
              
              results.fileDetails.push(fileDetail);
            }
          }
        }
      });
    }
    
    // Extract error messages but be more selective and filter noise
    
    // Filter out common noise phrases
    const noisePatterns = [
      /Test results indicate that your code still contains bugs/i,
      /Your code appears to cover only/i,
      /only \d+%/i
    ];
    
    // Remove duplicate or redundant error messages
    const uniqueMessages = new Set<string>();
    
    // Process error messages to be more concise
    results.errorMessages = results.errorMessages
      .filter(msg => {
        // Skip noise messages
        for (const pattern of noisePatterns) {
          if (pattern.test(msg)) return false;
        }
        return true;
      })
      .filter(msg => {
        // Skip if it's a duplicate in essence (contains the same key information)
        const lowerMsg = msg.toLowerCase();
        // Skip problem coverage messages - we'll add this separately
        if (lowerMsg.includes("problem coverage")) return false;
        
        for (const existingMsg of uniqueMessages) {
          if (lowerMsg.includes(existingMsg.toLowerCase())) return false;
          if (existingMsg.toLowerCase().includes(lowerMsg)) return false;
        }
        uniqueMessages.add(msg);
        return true;
      });

    // We don't need to add coverage as a message since it's displayed separately in the UI
    // This removes the redundant coverage message
    
    return results;
  } catch (error) {
    console.error("Error parsing Web-CAT HTML:", error);
    return null;
  }
};

/**
 * Generate the summary tab content
 */
const generateSummaryTab = (results: WebCATResults): string => {
  const totalScoreParts = results.totalScore.split('/');
  const scoreValue = parseFloat(totalScoreParts[0]);
  const scoreMax = parseFloat(totalScoreParts[1]);
  const scorePercentage = isNaN(scoreValue) || isNaN(scoreMax) || scoreMax === 0 ? 0 : (scoreValue / scoreMax) * 100;
  const isFailed = scorePercentage === 0 || results.coverage.includes('0%');
  
  // Process coverage text to separate the "Problem coverage:" prefix from the percentage value
  let coveragePrefix = '';
  let coverageValue = results.coverage;
  
  if (results.coverage) {
    const matches = results.coverage.match(/^(Problem coverage:)\s+(.+)$/i);
    if (matches && matches.length >= 3) {
      coveragePrefix = matches[1];
      coverageValue = matches[2].trim();
    }
  }
  
  // Create the error messages section if there are any
  const errorMessagesSection = results.errorMessages.length > 0 ? `
    <div class="results-card error-messages">
      <h3>Fix These Issues</h3> 
      <ul class="error-list">
        ${results.errorMessages.map(msg => `
          <li class="error-item">${msg}</li>
        `).join('')}
      </ul>
    </div>
  ` : '';
  
  return `
    <div class="results-summary">
      <div class="results-card">
        <h3>Submission Information</h3>
        <p><strong>Assignment:</strong> ${results.assignment}</p>
        <p><strong>Student:</strong> ${results.student}</p>
        <p><strong>Submitted:</strong> ${results.submitted}</p>
      </div>
      
      <div class="results-card">
        <h3>Score Summary</h3>
        <div style="font-size: 24px; text-align: center; margin: 15px 0;">
          <strong class="${isFailed ? 'error-score' : ''}">${results.totalScore}</strong>
        </div>
        <div class="progress-bar">
          <div class="progress-value" style="width: ${scorePercentage}%"></div>
        </div>
        
        ${results.coverage ? `
        <p style="margin-top: 15px;">
          <span>${coveragePrefix} </span>
          <span class="${coverageValue.includes('0%') || coverageValue === 'unknown' ? 'error-score' : ''}">${coverageValue}</span>
        </p>
        ` : ''}
      </div>
    </div>
    
    ${errorMessagesSection}
    
    ${results.scoreBreakdown.length > 0 ? `
    <div class="results-card">
      <h3>Score Breakdown</h3>
      ${results.scoreBreakdown.map((item: ScoreItem) => `
        <div class="score-item">
          <span>${item.label}</span>
          <strong>${item.score}</strong>
        </div>
      `).join('')}
    </div>
    ` : ''}
  `;
};

/**
 * Generate the details tab content
 */
const generateDetailsTab = (results: WebCATResults): string => {
  if (!results) return '<p>No detailed information available</p>';
  
  return `
    <div class="results-card">
      <h3>File Details</h3>
      ${results.fileDetails.length > 0 ? `
        <table class="file-table">
          <thead>
            <tr>
              <th>Filename</th>
              <th>Auto Comments</th>
              <th>Auto Points</th>
            </tr>
          </thead>
          <tbody>
            ${results.fileDetails.map((file: FileDetail) => `
              <tr>
                <td>${file.filename}</td>
                <td>${file.autoComments}</td>
                <td>${file.autoPoints}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : '<p>No file details available</p>'}
    </div>
    
    ${results.downloadables.length > 0 ? `
      <div class="results-card" style="margin-top: 20px;">
        <h3>Downloadable Files</h3>
        <ul>
          ${results.downloadables.map((download: DownloadableFile) => `
            <li>${download.filename} - ${download.description}</li>
          `).join('')}
        </ul>
      </div>
    ` : ''}
  `;
};

const infoBox = (url: string) => `
<div class="wc-vsc-info">
  <p>Showing Web-CAT results. <a href="${url}">Click here to open in browser.</a>
</div>
<style>
.wc-vsc-info {
  padding: 20px;
  background: #4a8df8;
  color: white;
  border-radius: 5px;
  margin-bottom: 20px;
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

/**
 * Creates a webview with a modern UI that shows the WebCAT results
 */
const createSimpleView = (html: string, resultsUrl: string | null, errorMessage?: string): string => {
  const isQueued = html.includes("Assignment Queued for Grading");
  
  // Parse the Web-CAT results
  const parsedResults = parseWebCATResults(html);
  
  // Pre-render all content sections
  const summaryContent = parsedResults ? generateSummaryTab(parsedResults) : '<p>No summary information available</p>';
  const detailsContent = parsedResults ? generateDetailsTab(parsedResults) : '<p>No detailed information available</p>';
  
  return `<!DOCTYPE html>
  <html>
    <head>
      <title>Web-CAT Results</title>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          line-height: 1.5;
          padding: 20px;
          color: var(--vscode-editor-foreground);
          background-color: var(--vscode-editor-background);
          overflow-x: hidden;
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
          padding-bottom: 10px;
          border-bottom: 1px solid var(--vscode-panel-border);
        }
        .error-message {
          color: var(--vscode-errorForeground);
          padding: 10px;
          border-left: 4px solid var(--vscode-errorForeground);
          background-color: var(--vscode-inputValidation-errorBackground);
          margin: 15px 0;
        }
        .section {
          margin-bottom: 30px;
        }
        .section-header {
          font-size: 1.2em;
          font-weight: bold;
          margin-top: 25px;
          margin-bottom: 15px;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--vscode-panel-border);
        }
        .raw-html {
          padding: 15px;
          border: 1px solid var(--vscode-panel-border);
          overflow: auto;
          max-height: 400px;
          margin-top: 10px;
          font-family: 'SF Mono', Monaco, 'Courier New', monospace;
          font-size: 12px;
          white-space: pre-wrap;
        }
        pre {
          white-space: pre-wrap;
          word-break: break-all;
        }
        .results-summary {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          margin-bottom: 20px;
        }
        .results-card {
          background-color: var(--vscode-editor-inactiveSelectionBackground);
          border-radius: 5px;
          padding: 15px;
        }
        .error-messages {
          grid-column: 1 / span 2; /* Make error messages span full width */
          border-left: 4px solid var(--vscode-errorForeground);
          margin-bottom: 20px;
        }
        .error-list {
          margin: 0;
          padding-left: 20px;
        }
        .error-item {
          margin-bottom: 10px;
          color: var(--vscode-errorForeground);
          font-weight: 500;
          font-family: 'SF Mono', Monaco, 'Courier New', monospace;
        }
        .results-card h3 {
          margin-top: 0;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--vscode-panel-border);
        }
        .score-item {
          display: flex;
          justify-content: space-between;
          margin-bottom: 8px;
        }
        .file-table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 15px;
        }
        .file-table th, .file-table td {
          padding: 8px;
          text-align: left;
          border-bottom: 1px solid var(--vscode-panel-border);
        }
        .file-table th {
          background-color: var(--vscode-editor-inactiveSelectionBackground);
        }
        .progress-bar {
          height: 12px;
          background-color: var(--vscode-progressBar-background);
          border-radius: 6px;
          overflow: hidden;
        }
        .progress-value {
          height: 100%;
          background-color: var(--vscode-button-background);
        }
        .error-score {
          color: var(--vscode-errorForeground);
          font-weight: bold;
        }
        .divider {
          height: 1px;
          background-color: var(--vscode-panel-border);
          margin: 30px 0;
        }
        /* Added highlighting for error messages */
        .highlight-error {
          background-color: rgba(255, 0, 0, 0.1);
          padding: 2px 4px;
          border-radius: 2px;
        }
      </style>
    </head>
    <body>
      ${isQueued ? loadingBar : ''}
      
      <div class="header">
        <h2>Web-CAT Submission Results</h2>
        ${resultsUrl ? `<a href="${resultsUrl}" target="_blank">View in Browser</a>` : ''}
      </div>
      
      ${errorMessage ? `<div class="error-message"><p>${errorMessage}</p></div>` : ''}
      
      <!-- Summary Section -->
      <div class="section">
        <div class="section-header">Summary</div>
        ${isQueued ? `
        <div style="padding: 20px; text-align: center;">
          <h3>Assignment Queued for Grading</h3>
          <p>Your submission is currently in the grading queue. Please check back shortly.</p>
        </div>
        ` : ''}
        ${summaryContent}
      </div>
      
      <!-- Details Section -->
      <div class="section">
        <div class="section-header">File Details</div>
        ${detailsContent}
      </div>
    </body>
  </html>`;
};

// hi