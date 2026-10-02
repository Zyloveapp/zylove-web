// "✦ Zy" in cobalt, "love" in white.
export default function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-black tracking-tight ${className}`}>
      <span className="text-[#1B4FD8]">✦ Zy</span>
      <span className="text-white">love</span>
    </span>
  )
}
