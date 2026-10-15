param([string]$Keys, [string]$Out, [int]$Limit = 0, [int]$KeyDelay = 8, [int]$Skip = 0)
# 用 SendInput 把大千按鍵打進自己開的文字框（微軟注音），每句按 Enter 送字後讀回文字。
# 前景視窗不是本視窗就中止，避免按鍵打進別的程式。
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Globalization;
using System.Windows.Forms;
using System.Runtime.InteropServices;

[ComImport, Guid("71C6E74C-0F28-11D8-A82A-00065B84435C"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITfInputProcessorProfileMgr {
  [PreserveSig] int ActivateProfile(uint type, ushort langid, ref Guid clsid, ref Guid profile, IntPtr hkl, uint flags);
}

public static class MsBench {
  // 微軟注音 TIP（Get-WinUserLanguageList 的 0404:{clsid}{profile}）
  static void ActivateBopomofo() {
    Type t = Type.GetTypeFromCLSID(new Guid("33C53A50-F456-4884-B049-85FD643ECFED"));
    ITfInputProcessorProfileMgr m = (ITfInputProcessorProfileMgr)Activator.CreateInstance(t);
    Guid clsid = new Guid("B115690A-EA02-48D5-A231-E3578D2FDF80");
    Guid prof = new Guid("B2F9C502-1742-11D4-9790-0080C882687E");
    int hr = m.ActivateProfile(1, 0x0404, ref clsid, ref prof, IntPtr.Zero, 0x10000000);
    Console.WriteLine("ActivateProfile hr=0x" + hr.ToString("X8"));
  }

  [StructLayout(LayoutKind.Explicit, Size = 40)]
  struct INPUT {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public ushort vk;
    [FieldOffset(10)] public ushort scan;
    [FieldOffset(12)] public uint flags;
    [FieldOffset(16)] public uint time;
    [FieldOffset(24)] public IntPtr extra;
  }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);
  [DllImport("imm32.dll")] static extern IntPtr ImmGetContext(IntPtr h);
  [DllImport("imm32.dll")] static extern bool ImmReleaseContext(IntPtr h, IntPtr c);
  [DllImport("imm32.dll")] static extern bool ImmSetOpenStatus(IntPtr c, bool open);
  [DllImport("imm32.dll")] static extern bool ImmGetOpenStatus(IntPtr c);
  [DllImport("imm32.dll")] static extern bool ImmGetConversionStatus(IntPtr c, out uint conv, out uint sent);
  [DllImport("imm32.dll")] static extern bool ImmSetConversionStatus(IntPtr c, uint conv, uint sent);

  // 打開 IME 並設成中文（IME_CMODE_NATIVE）
  static string ImeOn() {
    IntPtr c = ImmGetContext(box.Handle);
    ImmSetOpenStatus(c, true);
    uint conv, sent;
    ImmGetConversionStatus(c, out conv, out sent);
    ImmSetConversionStatus(c, conv | 1u, sent);
    ImmGetConversionStatus(c, out conv, out sent);
    string r = "himc=" + c + " open=" + ImmGetOpenStatus(c) + " conv=0x" + conv.ToString("X");
    ImmReleaseContext(box.Handle, c);
    return r;
  }

  static Form form;
  static TextBox box;
  static IntPtr hwnd;

  static void Key(ushort vk, bool up) {
    INPUT[] a = new INPUT[1];
    a[0].type = 1;
    a[0].vk = vk;
    a[0].scan = (ushort)MapVirtualKey(vk, 0);
    a[0].flags = up ? 2u : 0u;
    SendInput(1, a, 40);
  }

  static void Press(ushort vk, int delay) {
    IntPtr fgw = GetForegroundWindow();
    if (fgw != hwnd) {
      uint pid;
      GetWindowThreadProcessId(fgw, out pid);
      string name = "?";
      try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
      throw new Exception("foreground lost to " + name + " hwnd=" + fgw);
    }
    Key(vk, false);
    Thread.Sleep(delay);
    Key(vk, true);
    Thread.Sleep(delay);
  }

  static string Text() {
    return (string)form.Invoke(new Func<string>(delegate { return box.Text; }));
  }

  public static void Run(string keysFile, string outFile, int limit, int delay, int skip) {
    timeBeginPeriod(1);
    string[] lines = File.ReadAllLines(keysFile, Encoding.UTF8);
    form = new Form();
    form.Text = "MS Bopomofo bench";
    form.TopMost = true;
    form.Width = 900;
    form.Height = 200;
    box = new TextBox();
    box.Multiline = true;
    box.Dock = DockStyle.Fill;
    box.Font = new System.Drawing.Font("Microsoft JhengHei", 16);
    form.Controls.Add(box);
    form.Shown += delegate {
      hwnd = form.Handle;
      foreach (InputLanguage l in InputLanguage.InstalledInputLanguages)
        if (l.Culture.Name == "zh-TW") InputLanguage.CurrentInputLanguage = l;
      ActivateBopomofo();
      form.Activate();
      box.Focus();
      Thread t = new Thread(delegate () {
        StreamWriter w = new StreamWriter(outFile, skip > 0, new UTF8Encoding(false));
        try {
          // 前景鎖：先送一下 Alt 再搶前景
          for (int i = 0; i < 30 && GetForegroundWindow() != hwnd; i++) {
            Key(0x12, false); Key(0x12, true);
            form.Invoke(new Action(delegate {
              uint pid;
              uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
              uint me = GetCurrentThreadId();
              AttachThreadInput(me, fg, true);
              ShowWindow(hwnd, 9);
              BringWindowToTop(hwnd);
              SetForegroundWindow(hwnd);
              AttachThreadInput(me, fg, false);
              box.Focus();
            }));
            Thread.Sleep(100);
          }
          Console.WriteLine("foreground ok: " + (GetForegroundWindow() == hwnd));
          Thread.Sleep(1000);
          // 校正中英模式：打 ㄅㄚ 一聲，出現 ASCII 就按 Shift 切換再試
          for (int i = 0; i < 3; i++) {
            form.Invoke(new Action(delegate { box.Clear(); }));
            Thread.Sleep(100);
            Press(0x31, delay); Press(0x38, delay); Press(0x20, delay);
            Thread.Sleep(200);
            Press(0x0D, delay);
            Thread.Sleep(300);
            string probe = Text().Trim();
            string lang = (string)form.Invoke(new Func<string>(delegate {
              InputLanguage c = InputLanguage.CurrentInputLanguage;
              return c.Culture.Name + " / " + c.LayoutName + " / ime=" + box.ImeMode;
            }));
            Console.WriteLine("probe " + i + ": " + probe + "  [" + lang + "]");
            if (probe.Length > 0 && probe[0] > 0x2000) break;
            if (i == 0) Console.WriteLine((string)form.Invoke(new Func<string>(ImeOn)));
            else { Press(0x10, delay); Thread.Sleep(300); }
          }
          int n = 0;
          for (int li = skip; li < lines.Length; li++) { string line = lines[li];
            if (limit > 0 && n >= limit) break;
            string[] f = line.Split('\t');
            if (f.Length < 3) continue;
            form.Invoke(new Action(delegate { box.Clear(); }));
            Thread.Sleep(50);
            foreach (string k in f[2].Split(',')) Press(ushort.Parse(k), delay);
            Thread.Sleep(60);
            Press(0x0D, delay);
            // 等 IME 把字送完：連續兩次讀到相同內容才算穩定
            string prev = null, cur = Text();
            for (int i = 0; i < 40 && cur != prev; i++) { Thread.Sleep(50); prev = cur; cur = Text(); }
            string got = cur.Replace("\r", "").Replace("\n", "");
            w.WriteLine(f[0] + "\t" + f[1] + "\t" + got);
            w.Flush();
            n++;
          }
        } catch (Exception e) {
          Console.WriteLine("ABORT: " + e.Message);
        } finally {
          w.Close();
          form.Invoke(new Action(delegate { form.Close(); }));
        }
      });
      t.IsBackground = true;
      t.Start();
    };
    Application.Run(form);
  }
}
'@
[MsBench]::Run($Keys, $Out, $Limit, $KeyDelay, $Skip)
