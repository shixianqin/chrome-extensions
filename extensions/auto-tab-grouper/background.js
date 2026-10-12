/**
 * @typedef {Object} TaskObject
 * @property {Promise<void>} [active] - The currently running task `Promise`
 * @property {boolean} [dirty] - Whether a new request came in during task execution, requiring another run
 */

/**
 * @typedef {Object} GroupRange
 * @property {number} startIndex - Index of the first tab in the group
 * @property {number} endIndex - Index of the last tab in the group
 */

/**
 * @typedef {chrome.tabs.Tab} Tab
 * @typedef {chrome.tabGroups.TabGroup} TabGroup
 * @typedef {Promise<any>[]} PromiseTasks
 */

// Matches URLs starting with `http`/`https`. Used to keep only real web pages
// and exclude everything else (`chrome://`, `about:`, `file:`, extension pages, etc.)
const HTTP_PATTERN = /^https?:\/\//;

// Matches a leading `www.` so that `www.example.com` is normalized to `example.com`.
const WWW_PATTERN = /^www\./;

/**
 * One task object per window, used to serialize grouping tasks within the same window.
 * Only one `group()` can run per window at a time, avoiding index corruption from concurrent tab operations.
 * @type {Map<number, TaskObject>}
 */
const RUN_TASKS_BY_WINDOW = new Map();

/**
 * Debounce timer id per window, avoiding frequent grouping triggers.
 * @type {Map<number, number>}
 */
const RUN_TIMERS_BY_WINDOW = new Map();

/**
 * Delay function.
 * The `sleep` here is an empirical delay that gives Chrome's tab move
 * animation time to settle before the next step (grouping, merging),
 * avoiding abrupt visual jumps. There is no official "animation done"
 * event to await, hence the fixed delay.
 * @param {number} [time] - Delay in milliseconds, defaults to 200
 */
function sleep(time) {
  return new Promise((resolve) => {
    setTimeout(resolve, time || 200);
  });
}

/**
 * Determines whether a tab is a valid tab that should participate in grouping.
 * Excludes:
 * - Pinned tabs: explicitly pinned by the user, should not be auto-grouped
 * - Split view tabs (`splitViewId` set to a real id): part of a split view,
 *   which has its own layout rules, so excluded from normal grouping
 * - Non-`http(s)` pages: such as `chrome://` and extension pages, which have no domain concept
 * @param {Tab} tab
 */
function isValidTab(tab) {
  if (tab.pinned || (tab.splitViewId && tab.splitViewId !== chrome.tabs.SPLIT_VIEW_ID_NONE)) {
    return false;
  }

  return HTTP_PATTERN.test(tab.url);
}

/**
 * Extracts the group name (domain) from a tab's URL, stripping a leading `www.`.
 * For example, `https://www.example.com/path` -> `example.com`.
 * Returns an empty string if URL parsing fails (e.g. invalid URL).
 * An empty name makes `processGroup` skip grouping and fall back to `ungroup`.
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
 * Finds an existing tab group in the specified window by title.
 * The title is the domain, so a group with the same name is a group for the same domain.
 * Returns `null` if not found.
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
 * Computes the start and end index of a tab group in the tab strip.
 * Relies on `allTabs` being sorted by index ascending (`chrome.tabs.query` defaults to this),
 * so the first tab encountered in the group is `startIndex` and the last is `endIndex`.
 * Note: tabs in the same group are always contiguous in the tab strip; Chrome guarantees this.
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
 * Creates a new tab group, puts all tabs into it, and sets the group title to the domain.
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
 * Merges tabs that do not yet belong to `groupId` into that group.
 *
 * This collects all tabs with `groupId !== groupId`, covering two cases:
 * - Ungrouped tabs: merged directly into the target group
 * - Tabs already in another group: `chrome.tabs.group` moves them out of their
 *   original group and into the target group automatically (no manual `ungroup`
 *   needed), so a user's manual grouping is overridden — consistent with this
 *   extension's "organize by domain" goal.
 *
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
 * Removes tabs from their respective tab groups (dissolving the grouping
 * relationship without closing the tabs).
 * Only processes tabs that are actually in a group; ungrouped ones are skipped.
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
 * Moves an existing tab group close to the active tab, so the currently
 * operated group sits right next to the active tab.
 * `groupRange` is the group's current start/end index in the tab strip,
 * `activeTabIndex` is the active tab's index.
 *
 * Move rules (only when at least one tab separates them):
 * - Group before active tab -> place it immediately left of active tab
 * - Group after active tab  -> place it immediately right of active tab
 * - Already adjacent, or group contains active tab -> no move
 *
 * Sleeps after each move to let the animation finish before continuing,
 * avoiding visual jumps.
 * @param {number} groupId
 * @param {number} activeTabIndex
 * @param {GroupRange} groupRange
 */
async function moveGroupCloseToActiveTab(groupId, activeTabIndex, groupRange) {
  const { startIndex, endIndex } = groupRange;

  // Group is before the active tab: target position is left of the active tab,
  // so the group's end sits right next to the active tab.
  // Only move when at least one tab separates them (> 1)
  if (activeTabIndex - endIndex > 1) {
    await chrome.tabGroups.move(groupId, {
      // Group's start index = active tab index - group length
      index: activeTabIndex - (endIndex - startIndex + 1),
    });

    await sleep();
  }

  // Group is after the active tab: target position is immediately right of the active tab
  else if (startIndex - activeTabIndex > 1) {
    await chrome.tabGroups.move(groupId, {
      index: activeTabIndex + 1,
    });

    await sleep();
  }
}

/**
 * Moves a set of not-yet-grouped scattered tabs close to the active tab,
 * preserving their relative order.
 *
 * Approach:
 * - Tabs are split into those before and after the active tab by position
 * - Tabs before: target position is immediately left of the active tab,
 *   laid out from right to left
 * - Tabs after: target position is immediately right of the active tab,
 *   laid out from left to right
 * - Only move tabs whose "current distance > target distance"; tabs already
 *   close enough stay put, reducing unnecessary moves
 *
 * Uses `Promise.all` to issue moves concurrently, then sleeps once for the animations.
 * @param {Tab[]} tabs
 * @param {number} activeTabIndex
 */
async function moveTabsCloseToActiveTab(tabs, activeTabIndex) {
  /** @type {PromiseTasks} */
  const tasks = [];

  /**
   * Records a pending move operation.
   * @param {Tab} tab
   * @param {number} offset - Index offset relative to the active tab (negative = left, positive = right)
   */
  const moveTab = (tab, offset) => {
    tasks.push(
      chrome.tabs.move(tab.id, {
        index: activeTabIndex + offset,
      }),
    );
  };

  // `offsetBefore` tracks how many tabs on the left have been placed (decrements as negative)
  let offsetBefore = 0;
  // `offsetAfter` tracks how many tabs on the right have been placed (increments as positive)
  let offsetAfter = 0;

  let reverseIndex = tabs.length;

  // Iterate backward to move tabs before the active tab closer.
  // Backward iteration processes tabs nearest the active tab first,
  // avoiding moves affecting the indices of subsequent tabs.
  while (reverseIndex--) {
    const tab = tabs[reverseIndex];
    const distance = tab.index - activeTabIndex;

    if (distance < 0) {
      offsetBefore--;

      // Current distance is farther than the target position, so a move is needed
      if (distance < offsetBefore) {
        moveTab(tab, offsetBefore);
      }
    }
  }

  // Iterate forward to move tabs after the active tab closer
  for (const tab of tabs) {
    const distance = tab.index - activeTabIndex;

    if (distance > 0) {
      offsetAfter++;

      // Current distance is farther than the target position, so a move is needed
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
 * Core organization logic: group all tabs in the specified window by domain.
 *
 * Flow:
 * 1. Query all tabs in the window, categorize by domain into `validTabsByName`
 * 2. If the active tab belongs to a not-yet-grouped domain, process that domain first (move it near the active tab)
 * 3. Process the remaining domains in turn:
 *    - Single tab or invalid domain: `ungroup`
 *    - Existing group with the same name: move the group near the active tab, then merge new tabs in
 *    - No group with the same name: move tabs near the active tab, then create a new group
 *
 * @param {number} windowId
 */
async function group(windowId) {
  const allTabs = await chrome.tabs.query({ windowId });

  /**
   * Valid tabs categorized by domain; key is the domain, value is the array of tabs under that domain.
   * The array order matches `allTabs` (ascending by index); the move logic depends on this order.
   * @type {Map<string, Tab[]>}
   */
  const validTabsByName = new Map();

  /**
   * Handles grouping logic for a single domain.
   * @param {string} name - Domain
   * @param {Tab[]} tabs - Tabs under this domain
   * @param {Tab} [activeTab] - The active tab, if this domain contains it
   */
  const processGroup = async (name, tabs, activeTab) => {
    if (name && tabs.length > 1) {
      // Re-query each time instead of using snapshot data, avoiding wrong
      // judgments after a group is deleted by other operations
      const group = await queryGroup(windowId, name);

      if (group) {
        // Existing group with the same name: move the whole group near the
        // active tab first, then merge new tabs in
        if (activeTab) {
          await moveGroupCloseToActiveTab(
            group.id,
            activeTab.index,
            getGroupRange(allTabs, group.id),
          );
        }

        await updateGroup(group.id, tabs);
      } else {
        // No group with the same name: move scattered tabs near the active
        // tab first, then create a new group
        if (activeTab) {
          await moveTabsCloseToActiveTab(tabs, activeTab.index);
        }

        await createGroup(windowId, name, tabs);
      }
    } else {
      // Single tab or invalid domain: do not group, remove from any existing group
      await ungroup(tabs);
    }
  };

  /**
   * Deferred processing of the group containing the active tab.
   * Because the active tab's index may change while moving other tabs,
   * we capture it in a closure first and process it uniformly after
   * iterating all tabs.
   * @type {null | (() => Promise<void>)}
   */
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

    // Record the not-yet-grouped domain containing the active tab, to process it first later
    if (tab.active && tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      processActiveTab = async () => {
        await processGroup(groupName, validTabsByName.get(groupName), tab);
        validTabsByName.delete(groupName);
      };
    }
  }

  // Process the group containing the active tab first, because this group
  // needs to move other tabs near the active tab; processing it first avoids
  // other operations affecting the already-captured tab index snapshot
  if (processActiveTab) {
    await processActiveTab();
  }

  for (const [name, tabs] of validTabsByName) {
    await processGroup(name, tabs);
  }
}

/**
 * Runs one organization task for the specified window, with serialization and a `dirty` flag.
 *
 * Design goals:
 * - Only one `group()` can run per window at a time, avoiding index corruption from concurrent tab operations
 * - If a new request comes in during task execution, mark `dirty` and run again after the current task ends
 * - Remove from the map after the task ends; the next call recreates it
 *
 * @param {number} windowId
 */
async function run(windowId) {
  let task = RUN_TASKS_BY_WINDOW.get(windowId);

  if (!task) {
    task = {};
    RUN_TASKS_BY_WINDOW.set(windowId, task);
  }

  if (task.active) {
    // A task is already running; mark `dirty` and it will run again after it ends
    task.dirty = true;
  } else {
    task.active = group(windowId)
      .finally(() => {
        // Remove from the map when the task ends (regardless of success or
        // failure) to avoid memory leaks
        RUN_TASKS_BY_WINDOW.delete(windowId);
      })
      .then(() => {
        // If a new request came in during execution, recursively run again
        if (task.dirty) {
          return run(windowId);
        }
      });
  }

  return task.active;
}

/**
 * Debounced trigger for the organization task.
 * Multiple triggers within 200ms for the same window execute only the last,
 * avoiding frequent tab operations.
 * @param {number} windowId
 */
function debounceRun(windowId) {
  clearTimeout(RUN_TIMERS_BY_WINDOW.get(windowId));
  RUN_TIMERS_BY_WINDOW.set(windowId, setTimeout(run, 200, windowId));
}

/**
 * Runs organization once for all normal windows, returning a `Promise` that
 * resolves when every window's task has finished.
 */
async function init() {
  const allWindows = await chrome.windows.getAll({
    windowTypes: [chrome.windows.WindowType.NORMAL],
  });

  return Promise.all(allWindows.map((win) => run(win.id)));
}

// Trigger organization when a new tab is created
chrome.tabs.onCreated.addListener((tab) => {
  debounceRun(tab.windowId);
});

// Trigger organization when the URL changes or the pinned state changes
chrome.tabs.onUpdated.addListener((_, info, tab) => {
  if (info.url || info.pinned !== undefined) {
    debounceRun(tab.windowId);
  }
});

// Trigger organization when a tab is closed (skip when the window is closing, since the whole window is gone)
chrome.tabs.onRemoved.addListener((_, info) => {
  if (!info.isWindowClosing) {
    debounceRun(info.windowId);
  }
});

// Initialize on browser startup
chrome.runtime.onStartup.addListener(init);

// Initialize on extension install/update
chrome.runtime.onInstalled.addListener(init);
