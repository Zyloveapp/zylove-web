// How to turn location back on after it was blocked — shown by the Explore
// location gate and by Settings → Update location.
export default function LocationHelp({ className = '' }: { className?: string }) {
  return (
    <div className={`space-y-3 text-left text-sm text-white/50 ${className}`}>
      <p>
        <span className="font-semibold text-white/70">iPhone/Safari:</span> Open your iPhone Settings → scroll to Safari →
        tap Location → select Allow
      </p>
      <p>
        <span className="font-semibold text-white/70">Android/Chrome:</span> Tap the lock icon in your address bar →
        Permissions → Location → Allow
      </p>
      <p>
        <span className="font-semibold text-white/70">Mac:</span> Open System Settings → Privacy &amp; Security → Location
        Services → make sure Safari (or your browser) is checked
      </p>
    </div>
  )
}
