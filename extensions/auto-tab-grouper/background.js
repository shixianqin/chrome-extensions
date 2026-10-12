/**
 * @typedef {Object} TaskObject
 * @property {Promise<void>} [active]
 * @property {boolean} [dirty]
 */

/**
 * @typedef {Object} GroupRange
 * @property {number} startIndex
 * @property {number} endIndex
 */

/**
 * @typedef {chrome.tabs.Tab} Tab
 * @typedef {chrome.tabGroups.TabGroup} TabGroup
 * @typedef {Promise<any>[]} PromiseTasks
 */

const HTTP_PATTERN = /^https?:\/\//;
const WWW_PATTERN = /^www\./;

/** @type {Map<number, TaskObject>} */
const RUN_TASKS_BY_WINDOW = new Map();

/** @type {Map<number, number>} */
const RUN_TIMERS_BY_WINDOW = new Map();

/**
 * @param {number} [time]
 */
function sleep(time) {
  return new Promise((resolve) => {
    setTimeout(resolve, time || 200);
  });
}

/**
 * @param {Tab} tab
 */
function isValidTab(tab) {
  if (tab.pinned || (tab.splitViewId && tab.splitViewId !== chrome.tabs.SPLIT_VIEW_ID_NONE)) {
    return false;
  }

  return HTTP_PATTERN.test(tab.url);
}

/**
 * @param {Tab} tab
 */
function createGroupName(tab) {
  try {
    return new URL(tab.url).host.replace(WWW_PATTERN, '');
  } catch {
    return '';
  }
}

/**
 * @param {number} windowId
 * @param {string} name
 */
async function queryGroup(windowId, name) {
  const tabGroups = await chrome.tabGroups.query({ windowId });

  for (const tabGroup of tabGroups) {
    if (tabGroup.title === name) {
      return tabGroup;
    }
  }

  return null;
}

/**
 * @param {Tab[]} allTabs
 * @param {number} groupId
 * @returns {GroupRange}
 */
function getGroupRange(allTabs, groupId) {
  let startIndex = -1;
  let endIndex = -1;

  for (const tab of allTabs) {
    if (tab.groupId === groupId) {
      if (startIndex < 0) {
        startIndex = tab.index;
      }

      endIndex = tab.index;
    }
  }

  return { startIndex, endIndex };
}

/**
 * @param {number} windowId
 * @param {string} title
 * @param {Tab[]} tabs
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
}

/**
 * @param {number} groupId
 * @param {Tab[]} tabs
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
    await chrome.tabs.group({ groupId, tabIds });
  }
}

/**
 * @param {Tab[]} tabs
 */
async function ungroup(tabs) {
  await Promise.all(
    tabs.map((tab) => {
      if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        return chrome.tabs.ungroup(tab.id);
      }
    }),
  );
}

/**
 * @param {number} groupId
 * @param {number} activeTabIndex
 * @param {GroupRange} groupRange
 */
async function moveGroupCloseToActiveTab(groupId, activeTabIndex, groupRange) {
  const { startIndex, endIndex } = groupRange;

  // before
  if (activeTabIndex - endIndex > 1) {
    await chrome.tabGroups.move(groupId, {
      index: activeTabIndex - (endIndex - startIndex + 1),
    });

    await sleep();
  }

  // after
  else if (startIndex - activeTabIndex > 1) {
    await chrome.tabGroups.move(groupId, {
      index: activeTabIndex + 1,
    });

    await sleep();
  }
}

/**
 * @param {Tab[]} tabs
 * @param {number} activeTabIndex
 */
async function moveTabsCloseToActiveTab(tabs, activeTabIndex) {
  /** @type {PromiseTasks} */
  const tasks = [];

  /**
   * @param {Tab} tab
   * @param {number} offset
   */
  const moveTab = (tab, offset) => {
    tasks.push(
      chrome.tabs.move(tab.id, {
        index: activeTabIndex + offset,
      }),
    );
  };

  let offsetBefore = 0;
  let offsetAfter = 0;

  let reverseIndex = tabs.length;

  while (reverseIndex--) {
    const tab = tabs[reverseIndex];
    const distance = tab.index - activeTabIndex;

    if (distance < 0) {
      offsetBefore--;

      if (distance < offsetBefore) {
        moveTab(tab, offsetBefore);
      }
    }
  }

  for (const tab of tabs) {
    const distance = tab.index - activeTabIndex;

    if (distance > 0) {
      offsetAfter++;

      if (distance > offsetAfter) {
        moveTab(tab, offsetAfter);
      }
    }
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
    await sleep();
  }
}

/**
 * @param {number} windowId
 */
async function group(windowId) {
  const allTabs = await chrome.tabs.query({ windowId });

  /**
   * @type {Map<string, Tab[]>}
   */
  const validTabsByName = new Map();

  /**
   * @param {string} name
   * @param {Tab[]} tabs
   * @param {Tab} [activeTab]
   */
  const processGroup = async (name, tabs, activeTab) => {
    if (name && tabs.length > 1) {
      const group = await queryGroup(windowId, name);

      if (group) {
        if (activeTab) {
          await moveGroupCloseToActiveTab(
            group.id,
            activeTab.index,
            getGroupRange(allTabs, group.id),
          );
        }

        await updateGroup(group.id, tabs);
      } else {
        if (activeTab) {
          await moveTabsCloseToActiveTab(tabs, activeTab.index);
        }

        await createGroup(windowId, name, tabs);
      }
    } else {
      await ungroup(tabs);
    }
  };

  /** @type {null | (() => Promise<void>)} */
  let processActiveTab = null;

  for (const tab of allTabs) {
    if (!isValidTab(tab)) {
      continue;
    }

    const groupName = createGroupName(tab);
    const validTabs = validTabsByName.get(groupName);

    if (validTabs) {
      validTabs.push(tab);
    } else {
      validTabsByName.set(groupName, [tab]);
    }

    if (tab.active && tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      processActiveTab = async () => {
        await processGroup(groupName, validTabsByName.get(groupName), tab);
        validTabsByName.delete(groupName);
      };
    }
  }

  if (processActiveTab) {
    await processActiveTab();
  }

  for (const [name, tabs] of validTabsByName) {
    await processGroup(name, tabs);
  }
}

/**
 * @param {number} windowId
 */
async function run(windowId) {
  let task = RUN_TASKS_BY_WINDOW.get(windowId);

  if (!task) {
    task = {};
    RUN_TASKS_BY_WINDOW.set(windowId, task);
  }

  if (task.active) {
    task.dirty = true;
  } else {
    task.active = group(windowId)
      .finally(() => {
        RUN_TASKS_BY_WINDOW.delete(windowId);
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
 * @param {number} windowId
 */
function debounceRun(windowId) {
  clearTimeout(RUN_TIMERS_BY_WINDOW.get(windowId));
  RUN_TIMERS_BY_WINDOW.set(windowId, setTimeout(run, 200, windowId));
}

async function init() {
  const allWindows = await chrome.windows.getAll({
    windowTypes: [chrome.windows.WindowType.NORMAL],
  });

  return Promise.all(allWindows.map((win) => run(win.id)));
}

chrome.tabs.onCreated.addListener((tab) => {
  debounceRun(tab.windowId);
});

chrome.tabs.onUpdated.addListener((_, info, tab) => {
  if (info.url || info.pinned !== undefined) {
    debounceRun(tab.windowId);
  }
});

chrome.tabs.onRemoved.addListener((_, info) => {
  if (!info.isWindowClosing) {
    debounceRun(info.windowId);
  }
});

chrome.runtime.onStartup.addListener(init);
chrome.runtime.onInstalled.addListener(init);
