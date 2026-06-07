const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, options, maxRetries = 5) {
  let baseDelay = 3000;
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, options);
    
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      let waitTime = retryAfter ? parseInt(retryAfter) * 1000 : baseDelay;
      console.warn(`[429 차단] ${waitTime/1000}초 대기 중...`);
      await sleep(waitTime);
      baseDelay *= 2;
      continue;
    }
    
    if (response.status === 401 || response.status === 403) {
      throw new Error(`인증 실패(${response.status}). 사내 Jira 페이지에 로그인되어 있는지 확인해 주세요.`);
    }

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("text/html")) {
      throw new Error("Jira 로그인 세션이 만료되었습니다.\n\n새 탭을 열어 사내 Jira에 접속해 로그인하신 후, 다시 전송 버튼을 눌러주세요.");
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`상태코드: ${response.status}\n상세이유: ${errorText}`);
    }
    
    return response;
  }
  throw new Error("서버 응답 지연. 잠시 후 다시 시도해주세요.");
}

function dataURLtoBlob(dataurl) {
  let arr = dataurl.split(','), mime = arr[0].match(/:(.*?);/)[1],
      bstr = atob(arr[1]), n = bstr.length, u8arr = new Uint8Array(n);
  while(n--) { u8arr[n] = bstr.charCodeAt(n); }
  return new Blob([u8arr], { type: mime });
}

const formatLabel = (str) => str ? str.replace(/\s+/g, '_') : '미지정';

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({ url: "https://btvcuration.github.io/campaign/" });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "OPEN_JIRA_TEST") {
    createJiraHierarchy(message.data, sender.tab.id);
    sendResponse({ status: "processing" });
  } 
  else if (message.action === "TAKE_SCREENSHOT") {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
      sendResponse({ dataUrl: dataUrl });
    });
    return true; 
  }
  else if (message.action === "TRANSFER_DATA_TO_CAMPAIGN_TOOL") {
    chrome.tabs.query({ url: "*://btvcuration.github.io/*" }, (tabs) => {
      if (tabs.length > 0) {
        const targetTabId = tabs[0].id;
        chrome.tabs.update(targetTabId, { active: true });
        chrome.windows.update(tabs[0].windowId, { focused: true });
        chrome.tabs.sendMessage(targetTabId, {
          action: "INJECT_AI_DATA",
          payload: message.payload
        });
      } else {
        chrome.tabs.create({ url: "https://btvcuration.github.io/campaign/" }, (newTab) => {
          chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
            if (tabId === newTab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener); 
              setTimeout(() => {
                chrome.tabs.sendMessage(newTab.id, {
                  action: "INJECT_AI_DATA",
                  payload: message.payload
                });
              }, 1500); 
            }
          });
        });
      }
    });
    return true; 
  }
});

async function createJiraHierarchy(data, sourceTabId) {
  const baseUrl = "https://jira.skbroadband.com";
  const projectKey = "BTVMKT"; 
  const targetUserId = data.parent.assignee;

  // 🌟 [중요] 일감 유형 명칭 원복! (이전에 성공했던 대문자 T 적용)
  const PARENT_ISSUE_TYPE = "Task";    
  const CHILD_ISSUE_TYPE = "Sub-Task"; 

  const START_DATE_FIELD = "customfield_10134"; 
  const FINISH_DATE_FIELD = "customfield_10135";

  try {
    const uniqueLabels = Array.from(new Set(data.children.flatMap(c => c.gnb.map(formatLabel))));

    // 1️⃣ 🌟 상위 일감 생성: null 전송 방지 로직 적용
    const parentFields = {
      project: { key: projectKey },
      summary: data.parent.title,
      description: data.parent.desc,
      issuetype: { name: PARENT_ISSUE_TYPE },
      reporter: { name: targetUserId },
      assignee: { name: targetUserId },
      labels: uniqueLabels
    };
    
    if (data.parent.startDate) parentFields[START_DATE_FIELD] = data.parent.startDate;
    if (data.parent.dueDate) parentFields[FINISH_DATE_FIELD] = data.parent.dueDate;

    const parentRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
      credentials: 'include',
      body: JSON.stringify({ fields: parentFields })
    });
    
    const parentResult = await parentRes.json();
    const parentKey = parentResult.key; 

    // ⚡ 속도 최적화
    await sleep(500); 

    // 🌟 상위 일감에 종합 표/워크플로우 이미지 첨부 (이전 코드에서 누락됐던 부분)
    if (data.parent.images && data.parent.images.length > 0) {
      for (const imgObj of data.parent.images) {
        if (imgObj.dataUrl) {
          const imageBlob = dataURLtoBlob(imgObj.dataUrl);
          const formData = new FormData();
          formData.append("file", imageBlob, imgObj.filename);

          await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}/attachments`, {
            method: 'POST',
            headers: { 'X-Atlassian-Token': 'no-check' }, 
            credentials: 'include',
            body: formData
          });
          await sleep(200); 
        }
      }
    }

    // 2️⃣ 하위 일감 일괄(Bulk) 생성
    const childUpdates = data.children.map(child => {
      const fieldData = {
        project: { key: projectKey },
        summary: child.title,
        description: child.desc, 
        issuetype: { name: CHILD_ISSUE_TYPE }, 
        parent: { key: parentKey },
        reporter: { name: targetUserId },
        assignee: { name: child.assignee || targetUserId },
        labels: child.gnb.map(formatLabel)
      };

      if (child.startDate) fieldData[START_DATE_FIELD] = child.startDate;
      if (child.dueDate) fieldData[FINISH_DATE_FIELD] = child.dueDate;

      return { fields: fieldData };
    });

    const childBulkRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
      credentials: 'include',
      body: JSON.stringify({ issueUpdates: childUpdates })
    });

    const childBulkResult = await childBulkRes.json();
    const createdIssues = childBulkResult.issues;

    // 3️⃣ 하위 일감 이미지 첨부
    for (let i = 0; i < data.children.length; i++) {
      const childData = data.children[i];
      if (!createdIssues || !createdIssues[i]) continue;
      const issueKey = createdIssues[i].key; 

      if (childData.imageData) {
        const imageBlob = dataURLtoBlob(childData.imageData);
        const formData = new FormData();
        formData.append("file", imageBlob, "preview.png");

        await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}/attachments`, {
          method: 'POST',
          headers: { 'X-Atlassian-Token': 'no-check' }, 
          credentials: 'include',
          body: formData
        });
        
        await sleep(300); 
      }
    }

    // 4️⃣ 완성된 지라 창 열기
    chrome.tabs.create({ url: `${baseUrl}/browse/${parentKey}` });

  } catch (error) {
    console.error("API 연동 에러:", error);
    if (sourceTabId) {
      chrome.scripting.executeScript({
        target: { tabId: sourceTabId },
        func: (errMsg) => alert("🚨 지라 전송 에러!\n\n" + errMsg),
        args: [error.message]
      }).catch(e => console.error(e));
    }
  }
}
