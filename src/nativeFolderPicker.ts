import {spawn} from 'node:child_process';
import path from 'node:path';

export type NativeAction = 'pick' | 'approve' | 'connect-cloudflare' | 'enable-notion';
export type NativeResult = {cancelled: true} | {cancelled: false; path: string};
export type NativeRunner = (command: string, args: string[]) => Promise<{code: number; stdout: string; stderr: string}>;

export const runNativeCommand: NativeRunner = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {shell:false, stdio:['ignore','pipe','pipe'], windowsHide:false});
  let stdout = '', stderr = '';
  const timer = setTimeout(() => child.kill(), 120_000);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', part => {stdout += part; if (stdout.length > 8192) child.kill();});
  child.stderr.on('data', part => {stderr += part; if (stderr.length > 8192) child.kill();});
  child.once('error', error => {clearTimeout(timer); reject(error);});
  child.once('close', code => {clearTimeout(timer); resolve({code:code ?? 1,stdout,stderr});});
});

export async function nativeFolderDialog(
  action: NativeAction,
  runner: NativeRunner = runNativeCommand,
  platform: NodeJS.Platform = process.platform
): Promise<NativeResult> {
  const choices: Array<[string,string[]]> = platform === 'darwin'
    ? [action === 'pick'
        ? ['osascript',['-e','POSIX path of (choose folder with prompt "Choose a folder for GPT Codex Flow")']]
        : ['osascript',['-e',action==='connect-cloudflare' ? 'button returned of (display dialog "Start a public Cloudflare connection for the selected GPT Codex Flow projects and shared permissions? The private connection URL must be kept secret." buttons {"Cancel", "Allow"} default button "Cancel" with icon caution)' : action==='enable-notion' ? 'button returned of (display dialog "Create optional Notion Memory instructions inside the selected approved project? Existing project files will be preserved. No Notion account connection will be made." buttons {"Cancel", "Allow"} default button "Cancel" with icon caution)' : 'button returned of (display dialog "Save this folder change in GPT Codex Flow?" buttons {"Cancel", "Allow"} default button "Cancel" with icon caution)']]]
    : platform === 'win32'
      ? [['powershell.exe',['-NoProfile','-NonInteractive','-Command', action === 'pick'
          ? 'Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description="Choose a folder for GPT Codex Flow"; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::WriteLine($d.SelectedPath)}'
          : 'Add-Type -AssemblyName System.Windows.Forms; if([System.Windows.Forms.MessageBox]::Show("'+(action==='enable-notion'?'Create optional Notion Memory instructions in this approved project? No existing file will be overwritten.':'Save this folder change in GPT Codex Flow?')+'","GPT Codex Flow",[System.Windows.Forms.MessageBoxButtons]::OKCancel,[System.Windows.Forms.MessageBoxIcon]::Warning) -eq [System.Windows.Forms.DialogResult]::OK){[Console]::WriteLine("Allow")}'
        ]]]
      : action === 'pick'
        ? [['zenity',['--file-selection','--directory','--title=Choose a folder for GPT Codex Flow']],['kdialog',['--getexistingdirectory','.','--title','Choose a folder for GPT Codex Flow']]]
        : [['zenity',['--question','--text='+ (action==='enable-notion'?'Create optional Notion Memory instructions in this approved project?':'Save this folder change in GPT Codex Flow?')]],['kdialog',['--yesno',action==='enable-notion'?'Create optional Notion Memory instructions in this approved project?':'Save this folder change in GPT Codex Flow?']]];
  let missing = 0;
  for (const [command,args] of choices) {
    let result: {code:number;stdout:string;stderr:string};
    try {result = await runner(command,args);}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {missing++; continue;}
      throw new Error('The system folder dialog could not open. Check the desktop session and try again.');
    }
    if (result.code !== 0) {
      if (/(-128|User canceled|cancelled|canceled)/i.test(result.stderr) || result.code === 1) return {cancelled:true};
      throw new Error('The system folder dialog could not complete. Check the desktop session and try again.');
    }
    // Both approval dialogs return a button label, never an absolute filesystem path.
    // In particular, connect-cloudflare must not fall through to folder path validation.
    if (action !== 'pick') return result.stdout.trim() === 'Allow' || platform === 'linux'
      ? {cancelled:false,path:''} : {cancelled:true};
    const selected = result.stdout.trim();
    const platformPath = platform === 'win32' ? path.win32 : path.posix;
    if (!selected || !platformPath.isAbsolute(selected)) return {cancelled:true};
    return {cancelled:false,path:platformPath.resolve(selected)};
  }
  if (missing === choices.length) throw new Error('No native folder chooser is available. Install Zenity or KDialog, or use Advanced manual setup.');
  return {cancelled:true};
}
