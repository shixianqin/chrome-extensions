/**
 * @typedef {chrome.tabs.Tab} Tab
 */

/**
 * @param {Tab} tab
 * @return {string}
 */
function getTabHost(tab) {
  try {
    return new URL(tab.url).host;
  } catch {
    return '';
  }
}

/**
 * @param {Tab} tab
 */
async function getTabIndex(tab) {
  return (await chrome.tabs.get(tab.id)).index;
}

/**
 * @param {Tab[]} tabs
 */
function isContiguous(tabs) {
  for (let index = 1; index < tabs.length; index++) {
    if (tabs[index].index - tabs[index - 1].index > 1) {
      return false;
    }
  }

  return true;
}

/**
 * @param {Tab[]} tabs
 */
function getAnchor(tabs) {
  let startIndex = 0;
  let maxStartIndex = 0;
  let maxLength = 1;

  for (let index = 1; index < tabs.length; index++) {
    if (tabs[index].index - tabs[index - 1].index > 1) {
      startIndex = index;
    }

    const length = index - startIndex + 1;

    if (length > maxLength) {
      maxStartIndex = startIndex;
      maxLength = length;
    }
  }

  return tabs[maxStartIndex];
}

/**
 * @param {Tab[]} tabs
 * @param {Tab} anchor
 */
function orderTabsForMove(tabs, anchor) {
  /** @type {Tab[]} */
  const orderedTabs = [];

  let seenAnchor = false;

  for (const tab of tabs) {
    if (tab === anchor) {
      seenAnchor = true;
    }

    if (seenAnchor) {
      orderedTabs.push(tab);
    } else {
      orderedTabs.unshift(tab);
    }
  }

  return orderedTabs;
}

/**
 * @param {Tab[]} tabs
 * @param {Tab} anchor
 */
async function moveTabs(tabs, anchor) {
  const orderedTabs = anchor === tabs[0] ? tabs : orderTabsForMove(tabs, anchor);
  const anchorIndex = await getTabIndex(anchor);

  let offsetBefore = 0;
  let offsetAfter = 0;

  for (const tab of orderedTabs) {
    if (tab === anchor) {
      continue;
    }

    const tabIndex = await getTabIndex(tab);
    const distance = tabIndex - anchorIndex;

    if (distance < 0) {
      offsetBefore--;

      if (distance < offsetBefore) {
        await chrome.tabs.move(tab.id, { index: anchorIndex + offsetBefore });
      }
    } else {
      offsetAfter++;

      if (distance > offsetAfter) {
        await chrome.tabs.move(tab.id, { index: anchorIndex + offsetAfter });
      }
    }
  }
}

/**
 * @param {number} windowId
 * @param {boolean} [avoidCrossingActiveTab]
 */
async function arrange(windowId, avoidCrossingActiveTab) {
  const allTabs = await chrome.tabs.query({ windowId });

  /** @type {Map<string, Tab[] & { activeTab?: Tab }>} */
  const tabsByKey = new Map();

  let activeTabIndex = -1;

  for (const tab of allTabs) {
    if (
      tab.pinned ||
      (tab.splitViewId !== undefined && tab.splitViewId !== chrome.tabs.SPLIT_VIEW_ID_NONE) ||
      tab.url === 'chrome://newtab/'
    ) {
      continue;
    }

    const tabHost = getTabHost(tab);

    if (!tabHost) {
      continue;
    }

    const key = tabHost + '/' + tab.groupId;
    const tabs = tabsByKey.get(key) || [];

    if (tabs.length === 0) {
      tabsByKey.set(key, tabs);
    }

    tabs.push(tab);

    if (tab.active) {
      tabs.activeTab = tab;
      activeTabIndex = tab.index;
    }
  }

  for (const tabs of tabsByKey.values()) {
    if (
      tabs.length < 2 ||
      isContiguous(tabs) ||
      (avoidCrossingActiveTab &&
        !tabs.activeTab &&
        tabs[0].index < activeTabIndex &&
        tabs[tabs.length - 1].index > activeTabIndex)
    ) {
      continue;
    }

    await moveTabs(tabs, tabs.activeTab || getAnchor(tabs));
  }
}

/**
 * @type {Map<number, { promise: Promise<void>, next?: () => Promise<void> }>}
 */
const TASK_BY_WINDOW = new Map();

/**
 * @param {number} windowId
 * @param {boolean} [avoidCrossingActiveTab]
 */
function schedule(windowId, avoidCrossingActiveTab) {
  let task = TASK_BY_WINDOW.get(windowId);

  if (task) {
    task.next = () => schedule(windowId, avoidCrossingActiveTab);
  } else {
    task = {
      promise: arrange(windowId, avoidCrossingActiveTab)
        .finally(() => {
          TASK_BY_WINDOW.delete(windowId);
        })
        .then(() => {
          return task.next?.();
        }),
    };

    TASK_BY_WINDOW.set(windowId, task);
  }

  return task.promise;
}

async function init() {
  const windows = await chrome.windows.getAll({
    windowTypes: [chrome.windows.WindowType.NORMAL],
  });

  await Promise.all(windows.map((win) => schedule(win.id)));
}

chrome.runtime.onStartup.addListener(init);
chrome.runtime.onInstalled.addListener(init);

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.url) {
    schedule(tab.windowId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.url !== undefined ||
    changeInfo.pinned !== undefined ||
    changeInfo.groupId !== undefined ||
    changeInfo.splitViewId !== undefined
  ) {
    schedule(tab.windowId, tab.active);
  }
});
