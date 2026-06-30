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
    
    // 기존 401, 403 처리
    if (response.status === 401 || response.status === 403) {
      throw new Error(`인증 실패(${response.status}). 사내 Jira 페이지에 로그인되어 있는지 확인해 주세요.`);
    }

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("text/html")) {
      throw new Error("Jira 로그인 세션이 만료되었습니다.\n\n새 탭을 열어 사내 Jira에 접속해 로그인하신 후, 다시 전송 버튼을 눌러주세요.");
    }

    if (!response.ok) {
      const errorText = await response.text();
      
      // 🌟 추가된 400 에러 맞춤형 안내 로직
      if (response.status === 400) {
        throw new Error(
          `Jira 요청 실패 (상태코드: 400)\n\n` +
          `주로 다음 두 가지 원인으로 발생합니다:\n` +
          `1. 사내 Jira 로그인이 풀려있는 경우 (새 탭에서 Jira 로그인 확인)\n` +
          `2. 설정 화면에 입력한 '기본 담당자 Jira ID'가 올바르지 않은 경우\n\n` +
          `[상세 원인]: ${errorText}`
        );
      }

      // 기타 에러 처리
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
      if (chrome.runtime.lastError) {
        console.error("캡처 에러:", chrome.runtime.lastError.message);
        sendResponse({ dataUrl: null });
      } else {
        sendResponse({ dataUrl: dataUrl });
      }
    });
    return true; 
  }

  // 3. Gemini 탭에서 받은 AI JSON 데이터를 캠페인 매니저 탭으로 중계
  else if (message.action === "TRANSFER_DATA_TO_CAMPAIGN_TOOL") {
    // 🌟 [수정] 캠페인 페이지(/campaign/)만 명확히 찾도록 URL 필터 구체화
    chrome.tabs.query({ url: "*://btvcuration.github.io/campaign/*" }, (tabs) => {
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

// Jira API 호출 및 계층구조 생성
async function createJiraHierarchy(data, sourceTabId) {
  const baseUrl = "https://jira.skbroadband.com";
  const projectKey = "BTVMKT"; 
  const targetUserId = data.parent.assignee;

  const PARENT_ISSUE_TYPE = "Task";    
  const CHILD_ISSUE_TYPE = "Sub-Task"; 

  const START_DATE_FIELD = "customfield_10134"; 
  const FINISH_DATE_FIELD = "customfield_10135";

  try {
    const uniqueLabels = Array.from(new Set(data.children.flatMap(c => c.gnb.map(formatLabel))));

    // 1️⃣ 상위 일감 생성
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

    console.log("🚀 부모 일감 생성 요청 중...");
    const parentRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
      credentials: 'include',
      body: JSON.stringify({ fields: parentFields })
    });
    
    const parentResult = await parentRes.json();
    const parentKey = parentResult.key; 
    console.log("✅ 부모 일감 생성 완료:", parentKey);

    await sleep(1000); 

    // 부모 일감에 종합 표 및 유저 플로우(Mermaid) 첨부
    if (data.parent.images && data.parent.images.length > 0) {
      console.log(`📸 부모 일감(${parentKey}) 이미지 첨부 시작 (${data.parent.images.length}장)`);
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
          console.log(`✅ 부모 첨부 완료: ${imgObj.filename}`);
          await sleep(500); 
        }
      }
    }

    // 2️⃣ 하위 일감 일괄(Bulk) 생성
    console.log("🚀 하위 일감 일괄 생성 요청 중...");
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
    console.log("✅ 하위 일감 생성 완료");

    if (data.rawGasData) {
      console.log("🚀 구글 폼 스케줄 DB 기록 시작...");
      const { meta, assignee, assets } = data.rawGasData;
      const GOOGLE_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSfCrr_sPlHbBuysq4UsIGVA4uV6Er2EstA_a06JZsy3VurIwA/formResponse';
      
      // 1. 개별 배너 데이터 전송 (타겟 모수는 비워둠)
      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        const assetData = asset.data || {};
        const gnbStr = Array.isArray(assetData.gnb) ? assetData.gnb.join(', ') : (assetData.gnb || '미지정');
        const mainCopy = assetData.mainTitle || assetData.copy || assetData.bannerCopy || assetData.previewTitle || assetData.topLogo || '카피 없음';
        const imgUrl = assetData.imageUrl || assetData.bgImg || assetData.bannerImg || assetData.previewImg || '';

        // 💡 해당 배너와 1:1 매칭되는 하위 Jira 티켓 링크 조립
        const childJiraUrl = createdIssues && createdIssues[i] ? `${baseUrl}/browse/${createdIssues[i].key}` : '';

        const formData = new URLSearchParams();
        formData.append('entry.277120784', meta.campaignName || ''); 
        formData.append('entry.722384889', meta.target || '');       
        
        // 타겟 모수 중복 집계 방지를 위해 일반 배너 행에는 모수를 비워둡니다.
        formData.append('entry.87044441', '');   

        formData.append('entry.948742228', assetData.startDate || '');     
        formData.append('entry.1792129849', assetData.dueDate || '');      
        formData.append('entry.906901914', assignee || '');     
        formData.append('entry.1782408630', childJiraUrl); // 부모 대신 하위 Jira 링크 삽입
        formData.append('entry.2039552472', asset.type || '');        
        formData.append('entry.1981730910', gnbStr);                  
        formData.append('entry.900075056', mainCopy);                
        formData.append('entry.986244523', assetData.landingValue || ''); 
        formData.append('entry.28621578', imgUrl);

        try {
          await fetch(GOOGLE_FORM_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData.toString()
          });
        } catch (err) {
          console.error(`❌ 배너 폼 전송 에러 (Asset ${i}):`, err);
        }
      }

      // 2. 타겟팅 캠페인일 경우, 타겟팅 운영 요청용 별도 행(Row) 1개 추가 전송
      if (meta.target === 'TARGET') {
        const bannerTypes = assets.map(a => a.name).join(', '); 
        
        // 💡 타겟팅 티켓은 Admin에서 배열의 맨 마지막에 추가되었으므로 assets.length 인덱스에 위치합니다.
        const targetChildJiraUrl = createdIssues && createdIssues[assets.length] ? `${baseUrl}/browse/${createdIssues[assets.length].key}` : '';

        const formData = new URLSearchParams();
        
        formData.append('entry.277120784', meta.campaignName || ''); 
        formData.append('entry.722384889', meta.target || '');       
        
        // 오직 이 '타겟팅 운영요청' 행에만 타겟 모수를 기록하여 AI가 1번만 합산하게 만듭니다.
        formData.append('entry.87044441', meta.targetSize || '');   

        formData.append('entry.948742228', meta.startDate || '');     
        formData.append('entry.1792129849', meta.dueDate || '');      
        formData.append('entry.906901914', assignee || '');     
        formData.append('entry.1782408630', targetChildJiraUrl); // 타겟팅 전용 하위 Jira 링크 삽입
        
        formData.append('entry.2039552472', 'TARGET_OPERATION'); 
        formData.append('entry.1981730910', '기타'); 
        formData.append('entry.900075056', `타겟팅 세팅 요청 (포함 배너: ${bannerTypes})`); 
        formData.append('entry.986244523', ''); 
        formData.append('entry.28621578', '');

        try {
          await fetch(GOOGLE_FORM_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData.toString()
          });
        } catch (err) {
          console.error(`❌ 타겟팅 별도 행 전송 에러:`, err);
        }
      }

      console.log("✅ 구글 폼 스케줄 DB 기록 완료");
    }

    // 3️⃣ 캡처된 이미지를 하위 일감에 각각 첨부파일로 업로드
    console.log("📸 하위 일감 이미지 첨부 시작...");
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
        console.log(`✅ 하위 첨부 완료: ${issueKey}`);
        await sleep(1000); 
      } else {
        console.warn(`⚠️ 하위 일감(${issueKey})에 첨부할 캡처 이미지가 비어 있습니다.`);
      }
    }

    // 4️⃣ 완성된 지라 창 열기
    console.log("🎉 모든 작업 완료! 지라 창을 엽니다.");
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
