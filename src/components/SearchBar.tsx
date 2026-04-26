import { useStore, removeTasks } from '../store'
import { isTaskInRecycleBin } from '../types'
import Select from './Select'

export default function SearchBar() {
  const tasks = useStore((s) => s.tasks)
  const searchQuery = useStore((s) => s.searchQuery)
  const setSearchQuery = useStore((s) => s.setSearchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const setFilterStatus = useStore((s) => s.setFilterStatus)
  const taskView = useStore((s) => s.taskView)
  const setTaskView = useStore((s) => s.setTaskView)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)

  const recycleBinCount = tasks.filter((task) => isTaskInRecycleBin(task)).length
  const failedActiveTasks = tasks.filter(
    (task) => !isTaskInRecycleBin(task) && task.status === 'error',
  )

  return (
    <div className="mt-6 mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setTaskView('gallery')}
          className={`px-3 py-1.5 rounded-xl text-sm transition ${
            taskView === 'gallery'
              ? 'bg-blue-500 text-white shadow-sm'
              : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06]'
          }`}
        >
          画廊
        </button>
        <button
          type="button"
          onClick={() => setTaskView('trash')}
          className={`px-3 py-1.5 rounded-xl text-sm transition ${
            taskView === 'trash'
              ? 'bg-blue-500 text-white shadow-sm'
              : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06]'
          }`}
        >
          回收站{recycleBinCount > 0 ? ` (${recycleBinCount})` : ''}
        </button>

        {taskView === 'gallery' && failedActiveTasks.length > 0 && (
          <button
            type="button"
            onClick={() =>
              setConfirmDialog({
                title: '清理失败项目',
                message: `确定将全部 ${failedActiveTasks.length} 条失败项目移入回收站吗？它们的提示词、配置和图片会暂时保留，可在回收站恢复。`,
                confirmText: '移入回收站',
                action: () => removeTasks(failedActiveTasks),
              })
            }
            className="px-3 py-1.5 rounded-xl border border-red-200/80 bg-red-50 text-sm text-red-500 transition hover:bg-red-100/80 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20"
          >
            一键删除失败项目
          </button>
        )}

        {taskView === 'trash' && (
          <span className="text-xs text-gray-400 dark:text-gray-500">
            回收站项目会每 10 分钟轮询一次，自动清理 7 天前的记录
          </span>
        )}
      </div>
      <div className="flex gap-3">
        <div className="relative w-32 flex-shrink-0 z-20">
          <Select
            value={filterStatus}
            onChange={(val) => setFilterStatus(val as any)}
            options={[
              { label: '全部状态', value: 'all' },
              { label: '已完成', value: 'done' },
              { label: '生成中', value: 'running' },
              { label: '失败', value: 'error' },
            ]}
            className="px-4 py-2.5 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-white/[0.06] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition"
          />
        </div>
        <div className="relative flex-1 z-10">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            type="text"
            placeholder={
              taskView === 'trash'
                ? '搜索回收站里的提示词、参数、供应商...'
                : '搜索提示词、参数、供应商...'
            }
            className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition"
          />
        </div>
      </div>
    </div>
  )
}
