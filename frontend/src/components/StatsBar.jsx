import { Activity, Zap, HardDrive } from 'lucide-react'

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

export function StatsBar({ stats, capturing }) {
  return (
    <footer className="h-8 px-4 flex items-center justify-between border-t border-[#262626] bg-[#0a0a0a] text-xs">
      {/* Status */}
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${capturing ? 'bg-green-500 animate-pulse' : 'bg-[#525252]'}`} />
        <span className="text-[#a1a1a1]">
          {capturing ? 'Capturing' : 'Idle'}
        </span>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-6 text-[#a1a1a1]">
        <div className="flex items-center gap-1.5">
          <Zap className="w-3.5 h-3.5 text-[#525252]" />
          <span className="mono">{stats.packets.toLocaleString()}</span>
          <span className="text-[#525252]">packets</span>
        </div>

        <div className="flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5 text-[#525252]" />
          <span className="mono">{stats.flows.toLocaleString()}</span>
          <span className="text-[#525252]">flows</span>
        </div>

        <div className="flex items-center gap-1.5">
          <HardDrive className="w-3.5 h-3.5 text-[#525252]" />
          <span className="mono">{formatBytes(stats.bytes)}</span>
          <span className="text-[#525252]">transferred</span>
        </div>
      </div>
    </footer>
  )
}
