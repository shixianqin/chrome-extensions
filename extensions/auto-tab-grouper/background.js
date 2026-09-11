const HTTP_PATTERN = /^https?:\/\//;
const WWW_PATTERN = /^www\./;

/**
 * @type {Map<number, {active?: Promise<void>, dirty?: boolean}>}
 */
const TASK_MAP = new Map();

/**
 * @param tab {chrome.tabs.Tab}
 */
function filterTab(tab) {
  if (tab.pinned || (tab.splitViewId && tab.splitViewId !== chrome.tabs.SPLIT_VIEW_ID_NONE)) {
    return false;
  }

  return HTTP_PATTERN.test(tab.url);
}

/**
 * @param tab {chrome.tabs.Tab}
 */
function getTabName(tab) {
  try {
    return new URL(tab.url).host.replace(WWW_PATTERN, '');
  } catch {
    return null;
  }
}

/**
 * @param windowId {number}
 */
async function getAllTabs(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  return Map.groupBy(tabs.filter(filterTab), getTabName);
}

/**
 * @param windowId {number}
 */
async function getAllGroups(windowId) {
  const groups = await chrome.tabGroups.query({ windowId });
  return new Map(groups.map((g) => [g.title, g]));
}

/**
 * @param windowId {number}
 * @param title {string}
 * @param tabs {chrome.tabs.Tab[]}
 */
async function createGroup(windowId, title, tabs) {
  const groupId = await chrome.tabs.group({
    tabIds: tabs.map((tab) => tab.id),
    createProperties: {
      windowId,
    },
  });

  await chrome.tabGroups.update(groupId, {
    title,
  });

  return groupId;
}

/**
 * @param groupId {number}
 * @param tabs {chrome.tabs.Tab[]}
 */
async function updateGroup(groupId, tabs) {
  /** @type {number[]} */
  const tabIds = [];

  for (const tab of tabs) {
    if (tab.groupId !== groupId) {
      tabIds.push(tab.id);
    }
  }

  if (tabIds.length > 0) {
    await chrome.tabs.group({
      groupId,
      tabIds,
    });
  }
}

/**
 * @param tab {chrome.tabs.Tab}
 */
async function ungroup(tab) {
  if (tab.groupId && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    await chrome.tabs.ungroup(tab.id);
  }
}

/**
 * @param windowId {number}
 */
async function group(windowId) {
  const allTabs = await getAllTabs(windowId);
  const allGroups = await getAllGroups(windowId);

  /** @type {Promise<any>[]} */
  const tasks = [];

  for (const [name, tabs] of allTabs) {
    if (!name || tabs.length < 2) {
      for (const tab of tabs) {
        tasks.push(ungroup(tab));
      }
    } else {
      const existingGroup = allGroups.get(name);

      if (existingGroup) {
        tasks.push(updateGroup(existingGroup.id, tabs));
      } else {
        tasks.push(createGroup(windowId, name, tabs));
      }
    }
  }

  await Promise.all(tasks);
}

/**
 * @param windowId {number}
 */
async function run(windowId) {
  let task = TASK_MAP.get(windowId);

  if (!task) {
    task = {};
    TASK_MAP.set(windowId, task);
  }

  if (task.active) {
    task.dirty = true;
  } else {
    task.active = group(windowId)
      .finally(() => {
        TASK_MAP.delete(windowId);
      })
      .then(() => {
        if (task.dirty) {
          return run(windowId);
        }
      });
  }

  return task.active;
}

/**
 * @param windowId {number}
 */
async function debounceRun(windowId) {
  clearTimeout(debounceRun._timer);
  debounceRun._timer = setTimeout(run, 200, windowId);
}

async function init() {
  const allWindows = await chrome.windows.getAll({
    windowTypes: ['normal'],
  });

  for (const win of allWindows) {
    run(win.id);
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  run(tab.windowId);
});

chrome.tabs.onUpdated.addListener((_, info, tab) => {
  if (info.url || info.pinned !== undefined) {
    run(tab.windowId);
  }
});

chrome.tabs.onRemoved.addListener((_, info) => {
  if (!info.isWindowClosing) {
    debounceRun(info.windowId);
  }
});

chrome.runtime.onStartup.addListener(init);
chrome.runtime.onInstalled.addListener(init);
