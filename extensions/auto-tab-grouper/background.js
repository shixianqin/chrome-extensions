const HTTP_PATTERN = /^https?:\/\//;
const WWW_PATTERN = /^www\./;

/**
 * @param tab {chrome.tabs.Tab}
 * @returns {boolean}
 */
function filterTab(tab) {
  if (tab.pinned || (tab.splitViewId && tab.splitViewId !== chrome.tabs.SPLIT_VIEW_ID_NONE)) {
    return false;
  }

  return HTTP_PATTERN.test(tab.url);
}

/**
 * @param tab {chrome.tabs.Tab}
 * @returns {string}
 */
function getTabName(tab) {
  return new URL(tab.url).host.replace(WWW_PATTERN, '');
}

/**
 * @param windowId {number}
 * @returns {Promise<Map<string, chrome.tabs.Tab[]>>}
 */
async function getAllTabs(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  return Map.groupBy(tabs.filter(filterTab), getTabName);
}

/**
 * @param windowId {number}
 * @returns {Promise<Map<string, chrome.tabGroups.TabGroup>>}
 */
async function getAllGroups(windowId) {
  const groups = await chrome.tabGroups.query({ windowId });
  return new Map(groups.map((g) => [g.title, g]));
}

/**
 * @param windowId {number}
 */
async function group(windowId) {
  const allTabs = await getAllTabs(windowId);
  const allGroups = await getAllGroups(windowId);

  for (const [name, tabs] of allTabs) {
    if (tabs.length < 2) {
      if (tabs[0].groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        chrome.tabs.ungroup(tabs[0].id);
      }
      continue;
    }

    /** @type {chrome.tabGroups.TabGroup | undefined} */
    const existingGroup = allGroups.get(name);

    if (existingGroup) {
      /** @type {number[]} */
      const tabIds = [];

      for (const tab of tabs) {
        if (tab.groupId !== existingGroup.id) {
          tabIds.push(tab.id);
        }
      }

      if (tabIds.length > 0) {
        chrome.tabs.group({
          groupId: existingGroup.id,
          tabIds,
        });
      }
    } else {
      chrome.tabs
        .group({
          tabIds: tabs.map((tab) => tab.id),
          createProperties: {
            windowId,
          },
        })
        .then((groupId) => {
          chrome.tabGroups.update(groupId, {
            title: name,
          });
        });
    }
  }
}

/**
 * @param windowId {number}
 */
async function run(windowId) {
  await group(windowId);
}

async function runAll() {
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
    run(info.windowId);
  }
});

chrome.runtime.onStartup.addListener(runAll);
chrome.runtime.onInstalled.addListener(runAll);
