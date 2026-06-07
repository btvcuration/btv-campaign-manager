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

    // 🌟 [추가됨] 리다이렉트 함정 방어 (로그인 세션이 풀렸을 때 HTML 페이지가 반환되는 현상 차단)
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

// 띄어쓰기를 언더바로 치환 (Jira 레이블용)
const formatLabel = (str) => str ? str.replace(/\s+/g, '_') : '미지정';

// 확장 프로그램 아이콘 클릭 시 캠페인 매니저 열기
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({ url: "https://btvcuration.github.io/campaign/" });
});

// 메인 메시지 리스너
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  
  // 1. Jira 일감 생성 트리거
  if (message.action === "OPEN_JIRA_TEST") {
    createJiraHierarchy(message.data, sender.tab.id);
    sendResponse({ status: "processing" });
  } 
  
  // 2. 화면 네이티브 캡처 트리거
  else if (message.action === "TAKE_SCREENSHOT") {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
      sendResponse({ dataUrl: dataUrl });
    });
    return true; 
  }

  // 3. Gemini 탭에서 받은 AI JSON 데이터를 캠페인 매니저 탭으로 중계(Relay) 및 자동 실행
  else if (message.action === "TRANSFER_DATA_TO_CAMPAIGN_TOOL") {
    chrome.tabs.query({ url: "*://btvcuration.github.io/*" }, (tabs) => {
      
      // 케이스 A: 이미 탭이 열려있는 경우 -> 해당 탭으로 포커스 이동 후 즉시 전송
      if (tabs.length > 0) {
        const targetTabId = tabs[0].id;
        
        chrome.tabs.update(targetTabId, { active: true });
        chrome.windows.update(tabs[0].windowId, { focused: true });

        chrome.tabs.sendMessage(targetTabId, {
          action: "INJECT_AI_DATA",
          payload: message.payload
        });
      } 
      // 케이스 B: 탭이 없는 경우 -> 새 탭을 열고 로딩을 기다린 후 전송
      else {
        chrome.tabs.create({ url: "https://btvcuration.github.io/campaign/" }, (newTab) => {
          
          // 새 탭의 상태 업데이트 감시 리스너
          chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
            // 페이지 로딩이 '완료(complete)' 되었을 때
            if (tabId === newTab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener); // 1회용이므로 즉시 리스너 해제
              
              // React 앱이 렌더링되고 useEffect 리스너가 등록될 수 있도록 1.5초(1500ms) 여유 대기 후 쏨
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
    return true; // 비동기 처리를 위해 true 반환 유지
  }
});

// Jira API 호출 및 계층구조 생성
async function createJiraHierarchy(data, sourceTabId) {
  const baseUrl = "https://jira.skbroadband.com";
  const projectKey = "BTVMKT"; 
  const targetUserId = data.parent.assignee;

  // WBS Gantt-Chart 필드 매핑
  const START_DATE_FIELD = "customfield_10134"; 
  const FINISH_DATE_FIELD = "customfield_10135";

  try {
    // GNB 배열 데이터(다중 선택)를 모두 펼쳐서 상위 일감 레이블의 중복을 제거하고 추출
    const uniqueLabels = Array.from(new Set(data.children.flatMap(c => c.gnb.map(formatLabel))));

    // 1️⃣ 상위 일감 생성
    const parentPayload = {
      fields: {
        project: { key: projectKey },
        summary: data.parent.title,
        description: data.parent.desc,
        issuetype: { name: "Task" },
        reporter: { name: targetUserId },
        assignee: { name: targetUserId },
        labels: uniqueLabels,
        [START_DATE_FIELD]: data.parent.startDate || null,
        [FINISH_DATE_FIELD]: data.parent.dueDate || null
      }
    };

    const parentRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
      credentials: 'include',
      body: JSON.stringify(parentPayload)
    });
    
    const parentResult = await parentRes.json();
    const parentKey = parentResult.key; 

    await sleep(2000); 

    // 2️⃣ 하위 일감 일괄(Bulk) 생성
    const childUpdates = data.children.map(child => {
      const fieldData = {
        project: { key: projectKey },
        summary: child.title,
        description: child.desc, 
        issuetype: { name: "Sub-Task" }, 
        parent: { key: parentKey },
        reporter: { name: targetUserId },
        // 🌟 [수정됨] 하위 일감에 개별 assignee가 있으면 우선 적용, 없으면 부모 담당자(기획자) 적용
        assignee: { name: child.assignee || targetUserId },
        // 배열 형태로 넘어온 GNB 데이터를 매핑하여 레이블로 지정
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

    // 3️⃣ 캡처된 이미지를 하위 일감에 각각 첨부파일로 업로드
    for (let i = 0; i < data.children.length; i++) {
      const childData = data.children[i];
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
        
        await sleep(1500); 
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
      });
    }
  }
}