const HTTP_PATTERN = /^https?:\/\//;
const WWW_PATTERN = /^www\./;
const DELAY_TIMESTAMP = 200;

/**
 * @type {Map<number, {active?: Promise<void>, dirty?: boolean}>}
 */
const TASK_MAP = new Map();

/**
 * @param time {number}
 * @return {Promise<void>}
 */
function sleep(time) {
  return new Promise((resolve) => {
    setTimeout(resolve, time);
  });
}

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
 * @param title {string}
 * @param tabs {chrome.tabs.Tab[]}
 */
async function createGroup(title, tabs) {
  /** @type {number[]} */
  const tabIds = [];

  /** @type {chrome.tabs.Tab[]} */
  const normalTabs = [];

  /** @type {chrome.tabs.Tab | null} */
  let activeTab = null;

  for (const tab of tabs) {
    tabIds.push(tab.id);

    if (tab.active) {
      activeTab = tab;
    } else {
      if (activeTab) {
        // Tabs after active tab
        // [..., ACTIVE, 6, 7, 8]
        normalTabs.push(tab);
      } else {
        // Tabs before active tab
        // [3, 2, 1, ACTIVE, ...]
        normalTabs.unshift(tab);
      }
    }
  }

  if (activeTab) {
    /** @type {Promise<chrome.tabs.Tab>[]} */
    const moveTasks = [];
    const activeTabIndex = activeTab.index;

    let beforeOffset = 0;
    let afterOffset = 0;

    for (const tab of normalTabs) {
      if (tab.index < activeTabIndex) {
        beforeOffset += 1;

        moveTasks.push(
          chrome.tabs.move(tab.id, {
            index: activeTabIndex - beforeOffset,
          }),
        );
      } else {
        afterOffset += 1;

        moveTasks.push(
          chrome.tabs.move(tab.id, {
            index: activeTabIndex + afterOffset,
          }),
        );
      }
    }

    await Promise.all(moveTasks);
    await sleep(DELAY_TIMESTAMP);
  }

  const groupId = await chrome.tabs.group({
    tabIds,
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

  let groupStartIndex = -1;
  let groupEndIndex = -1;
  let activeTabIndex = -1;

  for (const tab of tabs) {
    if (tab.groupId === groupId) {
      if (groupStartIndex < 0) {
        groupStartIndex = tab.index;
      }

      groupEndIndex = tab.index;
    } else {
      tabIds.push(tab.id);

      if (tab.active && tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
        activeTabIndex = tab.index;
      }
    }
  }

  if (tabIds.length > 0) {
    if (activeTabIndex >= 0) {
      await chrome.tabGroups.move(groupId, {
        index:
          groupStartIndex < activeTabIndex
            ? activeTabIndex - 1 - (groupEndIndex - groupStartIndex) // Before active tab
            : activeTabIndex + 1, // After active tab
      });

      // Wait for the group movement animation to complete to avoid abrupt flickering.
      await sleep(DELAY_TIMESTAMP);
    }

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
        tasks.push(createGroup(name, tabs));
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
