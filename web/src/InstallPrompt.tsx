import { useEffect, useState } from 'react';
import { Sheet } from './ui';

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// Chrome-family browsers fire this once, early: keep it so the button can trigger the real install dialog.
let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    listeners.forEach((l) => l());
  });
}

const KEY = 'np_install_done';
const get = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const set = (v: string) => {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* private mode: it will simply ask again next visit */
  }
};

type Kind = 'ios' | 'huawei' | 'android' | 'other';

function detect() {
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const huawei = /HuaweiBrowser|HMSCore|HarmonyOS|HUAWEI|HONOR/i.test(ua);
  const android = /Android/i.test(ua);
  const mobile = ios || android || /Mobi/i.test(ua);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  const iosSafari = ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  const kind: Kind = ios ? 'ios' : huawei ? 'huawei' : android ? 'android' : 'other';
  return { kind, mobile, standalone, iosSafari };
}

/** The platform-specific "how to add this to your home screen" steps, with a one-tap install where the browser allows it. */
export function InstallSteps({ onDone }: { onDone?: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  const d = detect();
  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    const r = await deferred.userChoice.catch(() => null);
    deferred = null;
    if (r?.outcome === 'accepted') {
      set('installed');
      onDone?.();
    }
    tick((n) => n + 1);
  }
  return (
    <div className="install-steps">
      {deferred && (
        <button className="btn primary block" onClick={install}>
          Add to home screen
        </button>
      )}
      {d.kind === 'ios' && (
        <>
          {!d.iosSafari && <p className="muted small">On iPhone this works best in <b>Safari</b>. If you opened this link in another app, copy the address and open it in Safari first.</p>}
          <ol>
            <li>Tap the <b>Share</b> button (a square with an arrow pointing up) at the bottom of Safari.</li>
            <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
            <li>Tap <b>Add</b>. The app icon now sits with your other apps.</li>
          </ol>
        </>
      )}
      {d.kind === 'huawei' && (
        <ol>
          <li>Open the browser menu (the <b>three lines or dots</b> at the bottom or top right).</li>
          <li>Tap <b>Add to</b> and choose <b>Home screen</b> (some versions say <b>Add to desktop</b>).</li>
          <li>Confirm. The icon now sits on your home screen.</li>
        </ol>
      )}
      {d.kind === 'android' && !deferred && (
        <ol>
          <li>Open the browser menu (the <b>three dots</b> at the top right).</li>
          <li>Tap <b>Add to Home screen</b> or <b>Install app</b>.</li>
          <li>Confirm. The icon now sits on your home screen.</li>
        </ol>
      )}
      {d.kind === 'android' && deferred && <p className="muted small">Tap the button above and confirm. The icon is then on your home screen.</p>}
      {d.kind === 'other' && !deferred && <p className="muted small">On your phone, open this page and use the browser menu: <b>Add to Home screen</b> (Android) or Share, then <b>Add to Home Screen</b> (iPhone).</p>}
      <p className="muted small">It opens full screen like an app, and signing in once keeps you signed in for the day.</p>
    </div>
  );
}

/** Shown once, the first time someone is signed in on a phone browser. Not shown if already installed. */
export function InstallPrompt() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const d = detect();
    if (!d.mobile || d.standalone || get()) return;
    const t = setTimeout(() => setOpen(true), 1200);
    return () => clearTimeout(t);
  }, []);
  if (!open) return null;
  const close = (v: string) => {
    set(v);
    setOpen(false);
  };
  return (
    <Sheet title="Add this to your home screen" onClose={() => close('later')}>
      <p>Report in seconds without opening a browser or typing the address. Add the shortcut now:</p>
      <InstallSteps onDone={() => setOpen(false)} />
      <button className="btn block" onClick={() => close('done')}>
        Done
      </button>
      <button className="btn ghost block" onClick={() => close('later')}>
        Not now
      </button>
    </Sheet>
  );
}

/** For the Profile page: lets people open the same help any time. */
export function InstallPanel() {
  const [open, setOpen] = useState(false);
  const d = detect();
  if (d.standalone) return null;
  return (
    <section className="panel">
      <h2>Add to home screen</h2>
      <p className="muted small">Put a shortcut on your phone so reporting is one tap away.</p>
      <button className="btn" onClick={() => setOpen(true)}>Show me how</button>
      {open && (
        <Sheet title="Add this to your home screen" onClose={() => setOpen(false)}>
          <InstallSteps onDone={() => setOpen(false)} />
        </Sheet>
      )}
    </section>
  );
}
