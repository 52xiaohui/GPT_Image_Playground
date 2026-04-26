import { useEffect, useMemo, useRef, useState } from 'react'
import { type TaskRecord, isTaskInRecycleBin, resolveTaskProviderName } from '../types'
import { useStore, reuseConfig, editOutputs, removeTask, removeTasks, restoreTask, restoreTasks } from '../store'
import TaskCard from './TaskCard'

const INITIAL_VISIBLE_TASK_COUNT = 24
const LOAD_MORE_TASK_COUNT = 24

export default function TaskGrid() {
  const tasks = useStore((s) => s.tasks)
  const providers = useStore((s) => s.providers)
  const searchQuery = useStore((s) => s.searchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const taskView = useStore((s) => s.taskView)
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const toggleTaskSelection = useStore((s) => s.toggleTaskSelection)
  const clearSelectedTasks = useStore((s) => s.clearSelectedTasks)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_TASK_COUNT)
  const sourceTasks = useMemo(
    () =>
      tasks.filter((task) =>
        taskView === 'trash' ? isTaskInRecycleBin(task) : !isTaskInRecycleBin(task),
      ),
    [taskView, tasks],
  )

  const filteredTasks = useMemo(() => {
    const sorted = [...sourceTasks].sort((a, b) => {
      const timeA = taskView === 'trash' ? a.deletedAt ?? a.createdAt : a.createdAt
      const timeB = taskView === 'trash' ? b.deletedAt ?? b.createdAt : b.createdAt
      return timeB - timeA
    })
    const q = searchQuery.trim().toLowerCase()
    
    return sorted.filter((t) => {
      const matchStatus = filterStatus === 'all' || t.status === filterStatus
      if (!matchStatus) return false
      
      if (!q) return true
      const prompt = (t.prompt || '').toLowerCase()
      const paramStr = JSON.stringify(t.params).toLowerCase()
      const providerName = resolveTaskProviderName(t, providers).toLowerCase()
      return prompt.includes(q) || paramStr.includes(q) || providerName.includes(q)
    })
  }, [sourceTasks, taskView, providers, searchQuery, filterStatus])

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_TASK_COUNT)
  }, [searchQuery, filterStatus, taskView])

  useEffect(() => {
    if (visibleCount >= filteredTasks.length) return
    const node = loadMoreRef.current
    if (!node) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((count) =>
            Math.min(count + LOAD_MORE_TASK_COUNT, filteredTasks.length),
          )
        }
      },
      { rootMargin: '600px 0px' },
    )

    observer.observe(node)
    return () => observer.disconnect()
  }, [filteredTasks.length, visibleCount])

  const renderedTasks = useMemo(
    () => filteredTasks.slice(0, visibleCount),
    [filteredTasks, visibleCount],
  )

  const selectedIdSet = useMemo(() => new Set(selectedTaskIds), [selectedTaskIds])
  const visibleTaskIds = useMemo(() => filteredTasks.map((task) => task.id), [filteredTasks])
  const visibleTaskIdSet = useMemo(() => new Set(visibleTaskIds), [visibleTaskIds])

  const selectedTasks = useMemo(
    () => sourceTasks.filter((task) => selectedIdSet.has(task.id)),
    [sourceTasks, selectedIdSet],
  )
  const selectedCount = selectedIdSet.size

  const visibleSelectedCount = useMemo(
    () => visibleTaskIds.filter((id) => selectedIdSet.has(id)).length,
    [visibleTaskIds, selectedIdSet],
  )

  const hasVisibleTasks = visibleTaskIds.length > 0
  const allVisibleSelected = hasVisibleTasks && visibleSelectedCount === visibleTaskIds.length
  const showSelectionBar = hasVisibleTasks || selectedCount > 0

  const handleDelete = (task: TaskRecord) => {
    setConfirmDialog({
      title: '移入回收站',
      message: '确定要将这条记录移入回收站吗？提示词、配置和图片会暂时保留，可在回收站恢复。',
      confirmText: '移入回收站',
      action: () => removeTask(task),
    })
  }

  const handleRestore = (task: TaskRecord) => {
    setConfirmDialog({
      title: '恢复记录',
      message: '确定要将这条记录恢复到画廊吗？',
      confirmText: '恢复',
      action: () => restoreTask(task),
    })
  }

  const handleToggleAllVisible = () => {
    if (!hasVisibleTasks) return
    if (allVisibleSelected) {
      setSelectedTaskIds(selectedTaskIds.filter((id) => !visibleTaskIdSet.has(id)))
      return
    }
    setSelectedTaskIds(Array.from(new Set([...selectedTaskIds, ...visibleTaskIds])))
  }

  const handleBatchDelete = () => {
    if (!selectedTasks.length) return
    setConfirmDialog({
      title: '批量移入回收站',
      message: `确定要将选中的 ${selectedTasks.length} 条记录移入回收站吗？提示词、配置和图片会暂时保留，可在回收站恢复。`,
      confirmText: '移入回收站',
      action: () => removeTasks(selectedTasks),
    })
  }

  const handleBatchRestore = () => {
    if (!selectedTasks.length) return
    setConfirmDialog({
      title: '批量恢复记录',
      message: `确定要恢复选中的 ${selectedTasks.length} 条记录吗？`,
      confirmText: '恢复',
      action: () => restoreTasks(selectedTasks),
    })
  }

  return (
    <div className="space-y-4">
      {showSelectionBar && (
        <div className="flex flex-col gap-3 rounded-2xl border border-gray-200/80 bg-white/80 px-4 py-3 backdrop-blur-sm dark:border-white/[0.08] dark:bg-gray-900/70 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
              已选 {selectedCount} 项
            </p>
            {selectedCount > visibleSelectedCount && (
              <p className="text-xs text-gray-400 dark:text-gray-500">
                当前筛选结果中命中 {visibleSelectedCount} 项
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleToggleAllVisible}
              disabled={!hasVisibleTasks}
              className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.04]"
            >
              {allVisibleSelected ? '取消全选当前结果' : '全选当前结果'}
            </button>
            <button
              type="button"
              onClick={clearSelectedTasks}
              disabled={!selectedCount}
              className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.04]"
            >
              清空选择
            </button>
            <button
              type="button"
              onClick={taskView === 'trash' ? handleBatchRestore : handleBatchDelete}
              disabled={!selectedCount}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-40 ${
                taskView === 'trash'
                  ? 'bg-blue-500 hover:bg-blue-600'
                  : 'bg-red-500 hover:bg-red-600'
              }`}
            >
              {taskView === 'trash' ? '批量恢复' : '批量移入回收站'}
            </button>
          </div>
        </div>
      )}

      {!filteredTasks.length ? (
        <div className="text-center py-20 text-gray-400 dark:text-gray-500">
          {searchQuery ? (
            <p className="text-sm">没有找到匹配的记录</p>
          ) : taskView === 'trash' ? (
            <p className="text-sm">回收站为空</p>
          ) : (
            <>
              <svg
                className="w-16 h-16 mx-auto mb-4 text-gray-200 dark:text-gray-700"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1}
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
              <p className="text-sm">输入提示词开始生成图片</p>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs text-gray-400 dark:text-gray-500">
            <span>
              已显示 {Math.min(renderedTasks.length, filteredTasks.length)} / {filteredTasks.length} 条
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {renderedTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                providerName={resolveTaskProviderName(task, providers)}
                isInRecycleBin={taskView === 'trash'}
                selected={selectedIdSet.has(task.id)}
                onClick={() => setDetailTaskId(task.id)}
                onToggleSelect={() => toggleTaskSelection(task.id)}
                onReuse={() => reuseConfig(task)}
                onEditOutputs={() => editOutputs(task)}
                onDelete={() => handleDelete(task)}
                onRestore={() => handleRestore(task)}
              />
            ))}
          </div>
          {renderedTasks.length < filteredTasks.length && (
            <div className="flex flex-col items-center gap-3 pt-2">
              <div ref={loadMoreRef} className="h-4 w-full" />
              <button
                type="button"
                onClick={() =>
                  setVisibleCount((count) =>
                    Math.min(count + LOAD_MORE_TASK_COUNT, filteredTasks.length),
                  )
                }
                className="px-4 py-2 rounded-xl border border-gray-200 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.04]"
              >
                加载更多
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
