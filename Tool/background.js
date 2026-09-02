const CF_WORKER_URL = "https://btv-proxy.alcheminos.workers.dev";
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, options, maxRetries = 5) {
  let baseDelay = 3000;
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, options);
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      await sleep(retryAfter ? parseInt(retryAfter) * 1000 : baseDelay);
      baseDelay *= 2; continue;
    }
    if (response.status === 401 || response.status === 403) throw new Error(`인증 실패(${response.status}). 사내 Jira에 로그인해주세요.`);
    if (response.headers.get("content-type")?.includes("text/html")) throw new Error("Jira 세션 만료. 로그인 후 다시 시도해주세요.");
    if (!response.ok) throw new Error(`Jira 요청 실패 (상태코드: ${response.status})\n${await response.text()}`);
    return response;
  }
  throw new Error("서버 응답 지연.");
}

function dataURLtoBlob(dataurl) {
  let arr = dataurl.split(','), mime = arr[0].match(/:(.*?);/)[1], bstr = atob(arr[1]), n = bstr.length, u8arr = new Uint8Array(n);
  while(n--) { u8arr[n] = bstr.charCodeAt(n); }
  return new Blob([u8arr], { type: mime });
}

const formatLabel = (str) => str ? str.replace(/\s+/g, '_') : '미지정';

chrome.action.onClicked.addListener((tab) => chrome.tabs.create({ url: "https://btvcuration.github.io/campaign/" }));

// 🌟 [핵심 수정] 모든 메시지 리스너를 단 하나로 통합 (ReferenceError 원천 차단)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fetchCapaCsv') {
    fetch('https://btv-proxy.alcheminos.workers.dev/?action=getCapaCsv')
      .then(res => res.text()).then(csvText => sendResponse({ success: true, data: csvText }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; 
  }
  
  if (message.action === "OPEN_JIRA_TEST") { 
    createJiraHierarchy(message.data, sender.tab.id); 
    sendResponse({ status: "processing" }); 
    return true;
  } 
  
  if (message.action === "TAKE_SCREENSHOT") {
    const targetWindowId = sender.tab ? sender.tab.windowId : null;
    chrome.tabs.captureVisibleTab(targetWindowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.error("캡처 에러:", chrome.runtime.lastError.message);
        sendResponse({ dataUrl: null });
      } else {
        sendResponse({ dataUrl: dataUrl });
      }
    });
    return true; 
  }

  if (message.action === "CHECK_JIRA_SESSION") {
    fetch("https://jira.skbroadband.com/rest/api/2/myself", { credentials: "include" })
      .then(res => sendResponse({ isLogged: res.ok && !res.headers.get("content-type")?.includes("text/html") }))
      .catch(e => sendResponse({ isLogged: false }));
    return true;
  }
});

async function createJiraHierarchy(data, sourceTabId) {
  const baseUrl = "https://jira.skbroadband.com";
  const projectKey = "BTVMKT"; 
  const targetUserId = data.parent?.assignee || "system";
  const PARENT_ISSUE_TYPE = "Task", CHILD_ISSUE_TYPE = "Sub-Task"; 
  const START_DATE_FIELD = "customfield_10134", FINISH_DATE_FIELD = "customfield_10135";

  let parentKey = data.parentJiraKey || ""; 
  let createdIssues = [];

  try {
    if (!data.skipJira) {
      const uniqueLabels = Array.from(new Set(data.children.flatMap(c => c.gnb.map(formatLabel))));
      const parentFields = {
        project: { key: projectKey }, summary: data.parent.title, description: data.parent.desc,
        issuetype: { name: PARENT_ISSUE_TYPE }, reporter: { name: targetUserId }, assignee: { name: targetUserId }, labels: uniqueLabels
      };
      if (data.parent.startDate) parentFields[START_DATE_FIELD] = data.parent.startDate;
      if (data.parent.dueDate) parentFields[FINISH_DATE_FIELD] = data.parent.dueDate;

      if (parentKey) {
        // 🌟 [수정 모드] 부모 일감 업데이트 (PUT)
        console.log(`🚀 기존 부모 일감(${parentKey}) 업데이트 중...`);
        const updateFields = { ...parentFields };
        delete updateFields.project; delete updateFields.issuetype; 
        await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: updateFields }) });
        
        const pRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}`, { method: 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'include' });
        const pData = await pRes.json();
        const existingSubtasks = pData.fields?.subtasks || [];

        for (let i = 0; i < data.children.length; i++) {
          const childData = data.children[i];
          const childFields = {
            project: { key: projectKey }, summary: childData.title, description: childData.desc,
            issuetype: { name: CHILD_ISSUE_TYPE }, parent: { key: parentKey },
            reporter: { name: targetUserId }, assignee: { name: childData.assignee || targetUserId }, labels: childData.gnb.map(formatLabel)
          };
          if (childData.startDate) childFields[START_DATE_FIELD] = childData.startDate;
          if (childData.dueDate) childFields[FINISH_DATE_FIELD] = childData.dueDate;

          if (i < existingSubtasks.length) {
            const subKey = existingSubtasks[i].key;
            const cUpdateFields = { ...childFields };
            delete cUpdateFields.project; delete cUpdateFields.issuetype; delete cUpdateFields.parent;
            await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${subKey}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: cUpdateFields }) });
            createdIssues.push({ key: subKey });
          } else {
            const cRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: childFields }) });
            const cData = await cRes.json();
            createdIssues.push({ key: cData.key });
          }
        }
      } else {
        // 🌟 [신규 모드] 생성
        console.log("🚀 신규 부모 일감 생성 중...");
        const parentRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: parentFields }) });
        parentKey = (await parentRes.json()).key; 
        await sleep(1000); 

        const childUpdates = data.children.map(child => {
          const fieldData = { project: { key: projectKey }, summary: child.title, description: child.desc, issuetype: { name: CHILD_ISSUE_TYPE }, parent: { key: parentKey }, reporter: { name: targetUserId }, assignee: { name: child.assignee || targetUserId }, labels: child.gnb.map(formatLabel) };
          if (child.startDate) fieldData[START_DATE_FIELD] = child.startDate;
          if (child.dueDate) fieldData[FINISH_DATE_FIELD] = child.dueDate;
          return { fields: fieldData };
        });
        const childBulkRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ issueUpdates: childUpdates }) });
        createdIssues = (await childBulkRes.json()).issues;
      }

      if (data.parent.images && data.parent.images.length > 0) {
        for (const imgObj of data.parent.images) {
          if (imgObj.dataUrl) {
            const formData = new FormData(); formData.append("file", dataURLtoBlob(imgObj.dataUrl), imgObj.filename);
            await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}/attachments`, { method: 'POST', headers: { 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: formData });
            await sleep(500); 
          }
        }
      }
      if (data.parent.comment) {
        try { await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}/comment`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ body: data.parent.comment }) }); } catch(e){}
      }

      for (let i = 0; i < data.children.length; i++) {
        const childData = data.children[i];
        if (!createdIssues[i]) continue;
        const issueKey = createdIssues[i].key; 

        if (childData.imageData) {
          const formData = new FormData(); formData.append("file", dataURLtoBlob(childData.imageData), "preview.png");
          await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}/attachments`, { method: 'POST', headers: { 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: formData });
          await sleep(1000); 
        }
        if (childData.assignee) {
          try { await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}/comment`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ body: `담당자 [~${childData.assignee}]님, 캠페인 편성 세팅 확인 부탁드립니다.` }) }); } catch(e){}
        }
      }
    }

    if (data.rawGasData) {
      const { meta, assignee, assets } = data.rawGasData;
      const uniqueCode = data.uniqueCode || meta.uniqueCode;
      let bulkPayload = [];

      bulkPayload.push({
        jiraLink: parentKey ? `${baseUrl}/browse/${parentKey}` : "", 
        uniqueCode: uniqueCode, 
        campaignName: meta.campaignName || '신규 캠페인', product: meta.product || '', targetType: meta.target || 'MASS', channel: '캠페인 전체', hasBanner: assets.length > 0 ? 'Y' : 'N', taskType: data.skipJira ? '쿠폰/사은품 단독' : '캠페인 모일감', startDate: meta.startDate || '', endDate: meta.dueDate || '', assignee: assignee || '', targetSize: parseInt(meta.targetSize) || 0, targetCondition: meta.targetCondition || '', notiChannel: '', mainCopy: meta.conceptCopy || '캠페인 마스터', landingUrl: '', designLink: meta.mainImageUrl || '', hasCoupon: (meta.hasCoupon || '').trim().toUpperCase() === 'Y' ? 'Y' : 'N',
        assets: assets, mermaidCode: data.rawGasData.mermaidCode || "", meta: meta
      });

      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i]; const assetData = asset.data || {};
        const childJiraUrl = createdIssues[i] ? `${baseUrl}/browse/${createdIssues[i].key}` : '';
        let textParts = [];
        if (assetData.topText) textParts.push(assetData.topText); if (assetData.mainTitle) textParts.push(assetData.mainTitle); if (assetData.bannerCopy) textParts.push(assetData.bannerCopy); if (assetData.subTitle) textParts.push(assetData.subTitle);
        
        bulkPayload.push({
          jiraLink: childJiraUrl,
          uniqueCode: uniqueCode, 
          campaignName: meta.campaignName || '신규 캠페인', product: meta.product || '', targetType: meta.target || 'MASS', channel: Array.isArray(assetData.gnb) ? assetData.gnb.join(', ') : (assetData.gnb || '미지정'), hasBanner: asset.type && (asset.type.includes("BANNER") || asset.type.includes("TODAY")) ? "Y" : "N", taskType: asset.type || '기타', startDate: assetData.startDate || meta.startDate || '', endDate: assetData.dueDate || meta.dueDate || '', assignee: assignee || '', targetSize: 0, targetCondition: meta.targetCondition || '', notiChannel: '', mainCopy: textParts.length > 0 ? textParts.join(' / ') : '카피 없음', landingUrl: assetData.landingValue || '', designLink: assetData.imageUrl || assetData.bgImg || assetData.bannerImg || '', hasCoupon: (meta.hasCoupon || '').trim().toUpperCase() === 'Y' ? 'Y' : 'N'
        });
      }

      // 🌟 타겟 여부에 따른 DB 기록만 남기고, Jira 생성 로직에서는 완전 분리
      if (meta.target === 'TARGET') {
        const bannerTypes = assets.length > 0 ? assets.map(a => a.name).join(', ') : '배너 없음'; 
        bulkPayload.push({
          jiraLink: "", // 지라 생성 안 함
          uniqueCode: uniqueCode,
          campaignName: meta.campaignName || '신규 캠페인', product: meta.product || '', targetType: meta.target || 'TARGET', channel: '기타', hasBanner: 'N', taskType: 'TARGET_OPERATION', startDate: meta.startDate || '', endDate: meta.dueDate || '', assignee: assignee || '', targetSize: parseInt(meta.targetSize) || 0, targetCondition: meta.targetCondition || '', notiChannel: '', mainCopy: `타겟팅 세팅 요청 (포함 배너: ${bannerTypes})`, landingUrl: '', designLink: '', hasCoupon: (meta.hasCoupon || '').trim().toUpperCase() === 'Y' ? 'Y' : 'N'
        });
      }

      if (bulkPayload.length > 0) {
        await fetch(CF_WORKER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: "bulkInsert", rows: bulkPayload }) });
      }
    }

    if (!data.skipJira && parentKey) {
      chrome.tabs.create({ url: `${baseUrl}/browse/${parentKey}` });
    }
  } catch (error) {
    if (sourceTabId) chrome.scripting.executeScript({ target: { tabId: sourceTabId }, func: (errMsg) => alert("🚨 전송 에러!\n\n" + errMsg), args: [error.message] }).catch(e=>e);
  }
}
