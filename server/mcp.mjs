import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export const BOARD_URI = 'ui://xiangqi-coach/board-analysis-tt4462-v1.html';
const gameId = z.string().regex(/^[a-f0-9]{32}$/).describe('从工具结果取得的棋局编号，不可凭空编造');
const requestId = z.string().min(8).max(100).describe('一次用户操作的唯一编号；失败重试保留原编号');
const version = z.number().int().min(0).describe('刚读取的 game.version；旧版本会拒绝修改');
const move = z.string().min(4).max(20).describe('合法着法的 UCI 或工具返回的完整中文名称，例如 h2e2 或 炮二平五');
const ply = z.number().int().min(0).optional().describe('从 0 起的半回合数，0 为初始局面；省略分析当前局面');
const mutation = { gameId, expectedVersion: version, requestId };
const annotations = readOnlyHint => ({ readOnlyHint, destructiveHint: false, idempotentHint: true, openWorldHint: false });

export function toolDefinitions(service) {
  return [
    ['list_training', '残局训练题库', '读取原创与CCPD实战残局题库、主题、难度、星级、错题与最近作答。自动结算已到时挑战，题目答案不会提前返回。训练分为本地评分，不能换算成天天象棋段位。', { theme: z.string().max(40).optional(), difficulty: z.enum(['入门', '基础', '进阶']).optional(), source: z.enum(['original', 'ccpd']).optional(), mistakesOnly: z.boolean().default(false) }, false, args => service.training.list(args)],
    ['start_training', '开始残局训练', '开始独立训练棋局，随后用show_board显示。learn为学习，rated为首次计分作答，challenge为3分钟/5分钟/不限时挑战。在规定手数内将死或困毙均计胜，按完整核验的答案树判定；用户走后不主动泄露答案。', { requestId, puzzleId: z.string().min(1).max(100).optional(), mode: z.enum(['learn', 'rated', 'challenge']).default('learn'), durationSeconds: z.union([z.literal(0), z.literal(180), z.literal(300)]).default(180) }, false, args => service.training.start(args)],
    ['training_action', '训练提示、答案与重练', '当前训练题的提示、查看答案、重试或下一题。评分和挑战中使用提示/答案记本题未独立完成；重试进入学习模式。使用最新版本；重复请求不重复计分。', { ...mutation, action: z.enum(['hint', 'answer', 'retry', 'next']) }, false, args => service.training.action(args)],
    ['new_game', '开始一盘象棋', '新开棋局并自动保存。默认我执红，皮卡鱼自动应手。mode=record 时自己走红黑双方，摆好后复盘；fen 可指定合法局面。随后调用 show_board 显示可点击棋盘。', { requestId, playerSide: z.enum(['r', 'b']).default('r'), autoReply: z.boolean().default(true), mode: z.enum(['play', 'record']).default('play').describe('record 为自由录谱，用户走红黑双方，不自动应手；可用 fen 指定摆好的局面'), fen: z.string().max(140).optional().describe('可选的合法初始局面，两个字段；默认标准开局') }, false, args => service.newGame(args)],
    ['show_board', '显示象棋棋盘', '在对话内显示交互棋盘，支持点击落子、悔棋、变例演示及请求 GPT 讲解。无编号时显示最近棋局；过期训练挑战会自动保存结算。', { gameId: gameId.optional() }, false, async args => {
      const id = args.gameId ?? (await service.store.list())[0]?.id;
      return id ? service.read(id) : { needsNewGame: true };
    }],
    ['read_game', '读取棋局', '读取权威棋局、版本、轮次、合法着法与最近落子事实。lastLesson 可能尚未分析，按需完整讲解请用 explain_turn。不要根据聊天记忆推测棋盘。过期训练挑战会自动保存结算并更新版本。', { gameId }, false, args => service.read(args.gameId)],
    ['play_move', '提交用户着法', '提交用户的一步合法棋。自由录谱时可走当前行棋方的一步，不调用引擎应手。交互棋盘使用 deferReply=true，先立即保存用户棋步，再调用 engine_reply 让教练应手。省略时保留旧棋盘的分析与自动应手流程。走棋后不自动发讲解消息。', { ...mutation, move, deferReply: z.boolean().default(false).describe('true 时只校验并保存用户一步，不调用引擎；使用返回版本请求教练应手') }, false, args => service.play(args)],
    ['engine_reply', '教练应手', '在人机对弈轮到教练时走一步；训练题使用已验证的防守应手，自由录谱禁止代走。交互棋盘使用 fast=true，只搜索一次并保存应手，详细讲解按需调用 explain_turn。自动应手已完成时不要重复调用。', { ...mutation, fast: z.boolean().default(false).describe('true 时仅搜索首选应手，不提前生成完整回合分析') }, false, args => service.engineReply(args)],
    ['evaluate_position', '更新棋盘局势分', '后台评估真实历史局面，返回红黑双方的整数参考分（兵约100分的尺度，rawCp保留原始引擎分）。局势曲线统一红方视角：正为红优、负为黑优，50分内视为小波动；不是实际多出的棋子或胜率。mate和胜负单列。界面每次落子后自动请求，不阻塞走棋。', { gameId, expectedVersion: version.optional(), ply }, true, args => service.insights.evaluate(args)],
    ['start_review', '开始整局复盘', '后台逐手比较实走与推荐走法，按已还原的客户端规则生成本局表现分、优良中差错、阶段评分、转折点和引擎检出的漏杀。返回进度，使用read_review读取；不会修改实战。未结束的棋只复盘截至当前的棋谱，不能称作终局。', { gameId, expectedVersion: version }, false, args => service.reviews.start(args)],
    ['read_review', '读取复盘报告', '读取已保存的整局复盘和进度。ply指定一手时额外返回该手实走、推荐和已验证变例。obsolete=true说明原棋谱已撤回。评分只衡量本局，不能当棋力等级；官着库未接入，不能编造官着。', { gameId, reviewId: gameId, ply: z.number().int().min(1).optional() }, true, args => service.reviews.read(args)],
    ['retry_review_move', '从失误局面重新练习', '以复盘中指定着法之前的棋盘新建独立练习局。用户执当时行棋的一方、教练自动应手；原棋局与复盘完整保留，界面可返回原局。', { gameId, reviewId: gameId, ply: z.number().int().min(1), requestId }, false, args => service.reviews.practice(args)],
    ['prepare_lesson', '准备棋盘内讲解', '用户点讲解或提示时创建固定局面的讲解请求并返回验证证据。kind=position直接讲解当前局面，不要求已有着法；kind=review配合reviewId可讲整局复盘，另传ply可讲指定一手。请根据evidence写好中文正文，随后务必调用publish_lesson，显示在原棋盘内；不要把长篇正文只发到主对话。不会走棋。', { gameId, expectedVersion: version, requestId, kind: z.enum(['explain', 'hint', 'review', 'position']).default('explain'), reviewId: gameId.optional(), ply: z.number().int().min(1).optional() }, false, args => service.insights.prepare(args)],
    ['read_lesson', '读取棋盘讲解状态', '读取一个已创建的棋盘讲解请求。界面用它接收正文；模型缺少证据时传 includeEvidence=true 获取当时的固定证据，再调用 publish_lesson。用户已继续走棋时仍讲原请求，obsolete=true 表示原棋谱已撤回，应停止写入。', { gameId, requestId, includeEvidence: z.boolean().default(false) }, true, args => service.insights.readLesson(args)],
    ['publish_lesson', '把讲解显示在棋盘内', '把根据该请求验证证据写好的中文讲解正文保存到棋盘讲解栏。必须使用 prepare_lesson 或消息给出的 gameId、requestId；只写讲解，不改棋局。用户要提示时只给观察方向，不公布最佳着法。成功后原棋盘会显示正文，无需在主对话重复全文，也不要重新创建棋盘。', { gameId, requestId, text: z.string().trim().min(1).max(6000).describe('直接给用户看的中文正文，可分段；只使用验证过的中文着法。不要写取证过程、请求编号或原始 JSON。') }, false, args => service.insights.publish(args)],
    ['explain_turn', '获取这一回合的讲解证据', '仅在用户请求讲解或点击讲解按钮时调用。只读返回一个回合中双方实际走法与首选走法的短变例、分数和吃子将军事实，不附完整棋盘或历史。双方实际着法看 played；best 为对应证据的首选，可能与实走不同。source=reply_search 表示沿用应手时的搜索；on_demand_search 表示本次分析。证据足够时直接简短回答，无需再读取棋局或重复分析。', { gameId, expectedVersion: version.optional(), ply: z.number().int().min(1).optional().describe('要讲解的着法半回合编号，与 game.moves[].ply 相同，从1起；省略为最新回合，历史用户棋步会连同后续教练应手返回') }, true, args => service.explainTurn(args)],
    ['undo_move', '悔棋', '撤回一或两个半回合；默认撤回双方各一步。版本递增，其他旧棋盘必须刷新。', { ...mutation, plies: z.number().int().min(1).max(2).default(2) }, false, args => service.undo(args)],
    ['analyze_position', '分析局面或指定着法', '只分析不落子。候选不在前三时会强制搜索该着法。返回双方视角明确的分数、中文变例、吃子和将军事实。分析刚才用户的一步请传落子前的 ply。', { gameId, ply, candidate: move.optional() }, true, args => service.analyze(args)],
    ['preview_line', '试走一个变例', '从指定步数验证假设变例，只返回试走结果，不修改实战棋局。moves为空返回起点，可用于自由分析撤回全部试走；最多12手。', { gameId, ply, moves: z.array(move).max(12) }, true, args => service.preview(args)],
    ['list_games', '最近的棋局', '读取自动保存的最近 30 盘棋，可选择编号继续对弈。', {}, true, async () => ({ games: await service.store.list() })],
    ['export_game', '导出棋谱', '返回 PGN 棋谱文本和中文着法列表，默认兼容 XiangqiNotebook 的坐标格式，也可选标准 ICCS。棋局已经自动保存在本机。', { gameId, format: z.enum(['notebook', 'iccs']).default('notebook') }, true, args => service.export(args)],
  ].map(([name, title, description, schema, readOnly, run]) => ({ name, title, description, schema, annotations: annotations(readOnly), run }));
}

export async function callTool(definitions, name, args = {}) {
  try {
    const tool = definitions.find(tool => tool.name === name);
    if (!tool) throw new Error('没有这个象棋工具。');
    const data = await tool.run(z.object(tool.schema).strict().parse(args));
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof z.ZodError ? '参数不符合工具要求，请读取工具参数后重试。' : error.message }] };
  }
}

export function createServer(service) {
  const server = new McpServer({ name: 'xiangqi-coach', version: '0.1.0' }, {
    instructions: '你是象棋教练。用户要残局训练、刷题、错题重练或计时挑战时，先 list_training 选题，再 start_training 和 show_board；当前训练用 training_action 提示、答案、重试或下一题，不能先调用引擎分析泄露答案。评分和挑战用提示/答案会结束独立作答，重试进入学习。训练分和星级采用本地规则。整局评分已还原天天象棋4.4.6.2客户端公式与阈值，但使用本地引擎，不保证官方同分或段位；总分和阶段分使用displayAccuracy，旧报告outdatedMethod可重新复盘。新局先 new_game，再 show_board。用户要自由录谱或摆局面时使用 mode=record，红黑双方由用户录入，绝不调用 engine_reply；无着法的摆设局面用 prepare_lesson(kind=position) 分析后写回。当前棋局以工具读取为准。用户落子后默认不讲解；仅在用户明确请求或点击讲解按钮时回答。交互棋盘使用 play_move(deferReply=true) 先保存用户棋步，再 engine_reply(fast=true) 应手；play_move 省略 deferReply 时保留自动应手，不可重复落子。收到棋盘讲解请求后，根据已附验证证据直接写好简短中文正文，务必调用 publish_lesson(gameId,requestId,text) 写回原棋盘，不要只在主对话回复正文。缺证据才调用 read_lesson(includeEvidence=true)，不要重复分析已验证变例。没有 requestId 的直接询问可先 prepare_lesson。讲解双方实走看 played，2–4 个中文着法举例须有证据；提示只给观察方向，不公布答案。lastLesson 中 analysisPending=true 仅有落子事实，不是评价。只有额外未验证变化才用 preview_line；比较新指定着法用 analyze_position，不改变实战。评分归一到红方视角，cp 不是实物兵数，mate 不是普通分数。不要编造强制应手、得子或杀棋。',
  });
  const definitions = toolDefinitions(service);
  for (const tool of definitions) {
    registerAppTool(server, tool.name, {
      title: tool.title, description: tool.description, inputSchema: tool.schema, annotations: tool.annotations,
      _meta: { ui: { ...(tool.name === 'show_board' ? { resourceUri: BOARD_URI } : {}), visibility: ['model', 'app'] } },
    }, args => callTool(definitions, tool.name, args));
  }
  registerAppResource(server, '象棋教练棋盘', BOARD_URI, { description: '无外部网络请求的交互棋盘，供对话内展示与走棋。' }, async () => ({
    contents: [{ uri: BOARD_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(new URL('../dist/board.html', import.meta.url), 'utf8'),
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } }, 'openai/widgetDescription': '交互象棋棋盘，支持自由录谱、摆设局面、实时局势曲线、棋盘内讲解、复盘和失误练习。' },
    }],
  }));
  return server;
}
