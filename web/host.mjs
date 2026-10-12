import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

const iframe = document.getElementById('app');
const status = document.getElementById('status');
let hostContext = { theme: 'light', locale: 'zh-CN', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] };
const bridge = new AppBridge(null, { name: 'XiangqiCoach Local Acceptance', version: '0.1.0' }, { serverTools: {}, logging: {}, message: { text: {} }, updateModelContext: { text: {}, structuredContent: {} }, downloadFile: {} }, { hostContext });
bridge.onrequestdisplaymode = async ({ mode }) => {
  if (!hostContext.availableDisplayModes.includes(mode)) return { mode: hostContext.displayMode };
  hostContext = { ...hostContext, displayMode: mode };
  document.body.classList.toggle('expanded', mode === 'fullscreen');
  bridge.setHostContext(hostContext);
  return { mode };
};
const call = async (name, args) => {
  const response = await fetch('/dev/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
  if (!response.ok) throw new Error(`本地连接失败（${response.status}）`);
  return response.json();
};
bridge.oncalltool = params => call(params.name, params.arguments);
bridge.onupdatemodelcontext = async () => ({});
bridge.onmessage = async ({ content }) => {
  const article = document.createElement('article');
  article.textContent = '已收到讲解请求（本地验收，不生成 GPT 回答）\n\n' + content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  document.getElementById('messages').prepend(article);
  return {};
};
bridge.ondownloadfile = async ({ contents }) => {
  const resource = contents[0].resource;
  const url = URL.createObjectURL(new Blob([resource.text], { type: resource.mimeType }));
  const link = document.createElement('a'); link.href = url; link.download = resource.uri.split('/').at(-1); link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000); return {};
};
bridge.onsizechange = ({ height }) => { if (height) iframe.style.height = Math.ceil(height + 2) + 'px'; };
bridge.oninitialized = async () => {
  await bridge.sendToolInput({ arguments: {} });
  await bridge.sendToolResult(await call('show_board', {}));
  status.textContent = '棋盘已连接 · MCP Apps 握手完成';
};
await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
iframe.src = '/dev/board.html';
