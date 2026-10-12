import ccpd from './ccpd-puzzles.json' with { type: 'json' };

// The original section below is locally authored; the licensed CCPD adaptation
// is imported separately and retains its record-level attribution.
// Exhaustive finite-horizon search includes every legal winning player move and
// every defender reply. Xiangqi treats both checkmate and stalemate as a loss:
// goal: "mate" is the internal compatibility label for either decisive ending.
// Ratings only order this small practice set; they are not measured player Elo.
export const PUZZLE_CATALOG_VERSION = '2026-10-12.2';

export const ORIGINAL_PUZZLES = [
  {
    "id": "rook-ladder",
    "title": "双车错层",
    "theme": "双车",
    "difficulty": "入门",
    "rating": 600,
    "fen": "3k1a3/R5R2/9/8p/9/9/9/9/9/5K3 r",
    "goal": "mate",
    "maxPlayerMoves": 1,
    "hint": "一车守住下一横线，另一车登上底线将军。",
    "explanation": "双车分工封锁两条相邻横线。先确认下层车已控制将的退路，再用上层车完成最后一将。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "a8a9"
      ]
    ]
  },
  {
    "id": "rook-knight-net",
    "title": "车马封门",
    "theme": "车马",
    "difficulty": "入门",
    "rating": 650,
    "fen": "4k4/9/2NR1a3/9/9/9/9/9/9/3K5 r",
    "goal": "mate",
    "maxPlayerMoves": 1,
    "hint": "先找出马控制的宫心，再考虑让车从底线将军。",
    "explanation": "马守住宫心的逃点，车到敌方底线即可将杀；车也可吃掉侧面的士，封住另一条路使对方困毙。两种取胜方式都成立。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "d7d9"
      ],
      [
        "d7f7"
      ]
    ]
  },
  {
    "id": "stacked-cannons",
    "title": "重炮成杀",
    "theme": "双炮",
    "difficulty": "入门",
    "rating": 700,
    "fen": "3k5/9/3C5/8C/9/9/9/9/9/4K4 r",
    "goal": "mate",
    "maxPlayerMoves": 1,
    "hint": "把第二门炮移到同一路，让前炮成为后炮的炮架。",
    "explanation": "两炮叠在同一路，后炮借前炮将军；将往前走仍在炮线中，横向逃路又受到己方帅的牵制。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "i6d6"
      ]
    ]
  },
  {
    "id": "paired-pawns",
    "title": "双兵连环",
    "theme": "兵卒",
    "difficulty": "入门",
    "rating": 700,
    "fen": "2P1k4/3P5/9/8p/9/9/9/9/9/5K3 r",
    "goal": "mate",
    "maxPlayerMoves": 1,
    "hint": "不要只盯着进兵：底兵平一步，也能在同一横线上将军。",
    "explanation": "底兵横移后贴身将军，另一兵既保护进攻兵又控制宫心，帅再限制另一侧逃路。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "c9d9"
      ]
    ]
  },
  {
    "id": "cannon-pawn-screen",
    "title": "借兵架炮",
    "theme": "马炮兵",
    "difficulty": "入门",
    "rating": 750,
    "fen": "2P1k4/9/C8/3Np4/9/9/9/9/9/4K4 r",
    "goal": "mate",
    "maxPlayerMoves": 1,
    "hint": "敌方底线上已有可用炮架，马则守着将的前进点。",
    "explanation": "炮移到底线后借兵作架将军，马控制宫心，兵与马把炮的空档补齐。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "a7a9"
      ]
    ]
  },
  {
    "id": "black-cannon-rank",
    "title": "黑方重炮封横线",
    "theme": "双炮",
    "difficulty": "入门",
    "rating": 800,
    "fen": "5k3/9/9/9/9/9/8c/9/4A4/4Kc3 b",
    "goal": "mate",
    "maxPlayerMoves": 1,
    "hint": "先认清黑方的进攻方向，再把远炮调到与前炮同一横线。",
    "explanation": "两炮在同一横线上形成炮架。红帅既无法越过炮线，也不能吃掉炮架后与黑将照面。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "i3i0"
      ]
    ]
  },
  {
    "id": "cannons-pawn-lock",
    "title": "炮控士路",
    "theme": "炮兵",
    "difficulty": "入门",
    "rating": 850,
    "fen": "3ak4/5P3/9/7C1/6C2/9/9/9/9/3K5 r",
    "goal": "mate",
    "maxPlayerMoves": 1,
    "hint": "兵已封住将的逃点。把一门炮调到中路，让士也无法挪动。",
    "explanation": "炮调到中路后，士若离开底线就会成为炮架，导致己方将被将军。将与士都无合法着法，因此形成困毙；象棋中困毙也判负。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "g5e5"
      ],
      [
        "h6e6"
      ]
    ]
  },
  {
    "id": "black-rook-cross",
    "title": "黑方双车追将",
    "theme": "双车",
    "difficulty": "基础",
    "rating": 1000,
    "fen": "3k5/9/9/9/9/2r6/3r5/9/4K4/3A5 b",
    "goal": "mate",
    "maxPlayerMoves": 2,
    "hint": "每次将军都要给另一辆车留下接力位置；这里不止一种正确首着。",
    "explanation": "双车可沿横线或直线接力追将。对方将帅走向不同宫位时，第二辆车应改用相应的封锁线。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "c4c1",
        "e1e0",
        "d3d0"
      ],
      [
        "c4c1",
        "e1e2",
        "d3d2"
      ],
      [
        "c4e4",
        "e1f1",
        "d3f3"
      ],
      [
        "d3e3",
        "e1f1",
        "c4f4"
      ]
    ]
  },
  {
    "id": "rook-force-advisor",
    "title": "逼士堵门",
    "theme": "双车",
    "difficulty": "基础",
    "rating": 1000,
    "fen": "4ka3/9/9/R5R2/9/9/9/9/9/3K5 r",
    "goal": "mate",
    "maxPlayerMoves": 2,
    "hint": "可以用车从中路将军逼士回中，也可以先封住侧翼，再寻找最后的封锁着。",
    "explanation": "中路将军可逼士回中，再由另一车登底线将杀；也有先封侧翼、随后控制中路的变化。士被钉住时，对方即使未被将军也可能已经困毙。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "a6e6",
        "f9e8",
        "g6f6"
      ],
      [
        "a6e6",
        "f9e8",
        "g6g9"
      ],
      [
        "g6e6",
        "f9e8",
        "a6a9"
      ],
      [
        "g6f6",
        "e9e8",
        "a6e6"
      ],
      [
        "g6f6",
        "f9e8",
        "a6e6"
      ]
    ]
  },
  {
    "id": "pawn-before-rook",
    "title": "车兵封锁",
    "theme": "车兵",
    "difficulty": "基础",
    "rating": 1000,
    "fen": "4k4/9/6P2/1R7/9/9/9/9/9/3K5 r",
    "goal": "mate",
    "maxPlayerMoves": 2,
    "hint": "兵先靠近九宫是一条思路，也可以先用车将军逼将到侧面。",
    "explanation": "兵先占位时，车随后利用横线或直线将杀；先用车把将逼到侧面时，兵再封住最后的逃点，也可形成困毙。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "b6b8",
        "e9f9",
        "b8e8"
      ],
      [
        "b6b8",
        "e9f9",
        "d0e0"
      ],
      [
        "b6b9",
        "e9e8",
        "g7f7"
      ],
      [
        "b6e6",
        "e9f9",
        "e6e8"
      ],
      [
        "b6e6",
        "e9f9",
        "g7f7"
      ],
      [
        "b6e6",
        "e9f9",
        "g7g8"
      ],
      [
        "g7f7",
        "e9e8",
        "b6b9"
      ],
      [
        "g7f7",
        "e9e8",
        "b6e6"
      ],
      [
        "g7f7",
        "e9f9",
        "b6b9"
      ],
      [
        "g7f7",
        "e9f9",
        "b6e6"
      ],
      [
        "g7f7",
        "e9f9",
        "d0e0"
      ],
      [
        "g7g8",
        "e9e8",
        "b6e6"
      ],
      [
        "g7g8",
        "e9f9",
        "b6b9"
      ],
      [
        "g7g8",
        "e9f9",
        "b6e6"
      ],
      [
        "g7g8",
        "e9f9",
        "d0e0"
      ]
    ]
  },
  {
    "id": "rook-quiet-block",
    "title": "先封再杀",
    "theme": "双车",
    "difficulty": "基础",
    "rating": 1100,
    "fen": "R8/4k4/9/R3p4/9/9/9/9/9/3K5 r",
    "goal": "mate",
    "maxPlayerMoves": 2,
    "hint": "第一着先用底线车切断侧面逃路，下一着由另一车进入中路将军。",
    "explanation": "先横移底线车，再让另一车进入中路，是一条将杀路线。也可先吃卒将军，把将逼到侧面后调整车位困毙；两类取胜都成立。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "a6e6",
        "e8f8",
        "e6e7"
      ],
      [
        "a9f9",
        "e6e5",
        "a6e6"
      ],
      [
        "a9f9",
        "e8e7",
        "a6e6"
      ]
    ]
  },
  {
    "id": "knight-check-fork",
    "title": "先马后车",
    "theme": "车马",
    "difficulty": "基础",
    "rating": 1100,
    "fen": "4kaN2/9/4b4/6p2/8R/9/9/9/9/4K4 r",
    "goal": "mate",
    "maxPlayerMoves": 2,
    "hint": "先找马的将军跳点，再分别计算将左移和下移后的车杀。",
    "explanation": "马先将军并控制关键逃点。敌将留在底线时，车从直路进攻；敌将走到下一横线时，车改从该横线将杀。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "g9f7",
        "e9d9",
        "i5d5"
      ],
      [
        "g9f7",
        "e9e8",
        "i5i8"
      ]
    ]
  },
  {
    "id": "knight-cannon-discovery",
    "title": "马进炮架",
    "theme": "马炮",
    "difficulty": "基础",
    "rating": 1150,
    "fen": "1C1k5/9/9/9/2N6/9/9/9/9/5K3 r",
    "goal": "mate",
    "maxPlayerMoves": 2,
    "hint": "马的第一跳先封住将的前进点，第二跳要落到炮与将之间。",
    "explanation": "马先封住将的前进点，迫使将横走。一条路线让马成为炮架，另一条路线用马封住全部逃点形成困毙；两条路线都可在两手内取胜。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "c5b7",
        "d9e9",
        "b7c9"
      ],
      [
        "c5e6",
        "d9e9",
        "e6c7"
      ]
    ]
  },
  {
    "id": "rook-cannon-screen",
    "title": "车炮兵接力",
    "theme": "车炮",
    "difficulty": "基础",
    "rating": 1200,
    "fen": "3k1a3/1PR6/C8/p8/9/9/9/9/9/4K4 r",
    "goal": "mate",
    "maxPlayerMoves": 2,
    "hint": "炮、兵都可以先行。先布置炮位或炮架，再根据对方士的位置收尾。",
    "explanation": "兵提供炮架，车控制九宫前沿；炮也可以改到另一条横线，为车守住退路。士是否回中会改变最后一着，有多条正确解法。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "a7a8",
        "a6a5",
        "c8c9"
      ],
      [
        "a7a8",
        "a6a5",
        "c8d8"
      ],
      [
        "a7a8",
        "f9e8",
        "c8c9"
      ],
      [
        "a7a9",
        "a6a5",
        "b8b9"
      ],
      [
        "a7a9",
        "f9e8",
        "b8b9"
      ],
      [
        "b8b9",
        "a6a5",
        "a7a9"
      ],
      [
        "b8b9",
        "a6a5",
        "b9c9"
      ],
      [
        "b8b9",
        "f9e8",
        "a7a9"
      ]
    ]
  },
  {
    "id": "knight-cannon-choice",
    "title": "马退一步两路杀",
    "theme": "马炮兵",
    "difficulty": "基础",
    "rating": 1200,
    "fen": "3k1N3/9/9/4P4/3C5/9/9/9/9/3K5 r",
    "goal": "mate",
    "maxPlayerMoves": 2,
    "hint": "马先退到能控制九宫的新位置；将的两种走法，需要分别用兵和炮收尾。",
    "explanation": "马退后控制多个逃点。敌将向前走时可用兵横移成炮架，横走时可调炮借兵将军；也可调整炮或兵的位置形成困毙。先平兵后退马也是正确路线。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "e6d6",
        "d9e9",
        "f9g7"
      ],
      [
        "f9g7",
        "d9d8",
        "e6d6"
      ],
      [
        "f9g7",
        "d9e9",
        "d5a5"
      ],
      [
        "f9g7",
        "d9e9",
        "d5b5"
      ],
      [
        "f9g7",
        "d9e9",
        "d5c5"
      ],
      [
        "f9g7",
        "d9e9",
        "d5d9"
      ],
      [
        "f9g7",
        "d9e9",
        "d5e5"
      ],
      [
        "f9g7",
        "d9e9",
        "d5f5"
      ],
      [
        "f9g7",
        "d9e9",
        "d5g5"
      ],
      [
        "f9g7",
        "d9e9",
        "d5h5"
      ],
      [
        "f9g7",
        "d9e9",
        "d5i5"
      ],
      [
        "f9g7",
        "d9e9",
        "e6d6"
      ]
    ]
  },
  {
    "id": "black-knight-pawn",
    "title": "黑方马卒逼宫",
    "theme": "马兵",
    "difficulty": "基础",
    "rating": 1200,
    "fen": "5k3/9/9/9/9/9/P8/B1np5/9/4KA3 b",
    "goal": "mate",
    "maxPlayerMoves": 2,
    "hint": "马已经守住关键点，先让卒往前一步，再根据仕是否回中选择进卒或平卒。",
    "explanation": "马控制帅的逃点，卒逐步逼近。对方移动闲子时，卒继续前进将军；仕回中时，卒改为横吃仕成杀。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "d2d1",
        "a2c0",
        "d1d0"
      ],
      [
        "d2d1",
        "a2c4",
        "d1d0"
      ],
      [
        "d2d1",
        "a3a4",
        "d1d0"
      ],
      [
        "d2d1",
        "f0e1",
        "d1e1"
      ]
    ]
  },
  {
    "id": "knight-route",
    "title": "马兵三步围宫",
    "theme": "马兵",
    "difficulty": "进阶",
    "rating": 1400,
    "fen": "3k5/4P4/9/8p/6bN1/9/9/9/9/4K4 r",
    "goal": "mate",
    "maxPlayerMoves": 3,
    "hint": "兵已封住将的横向退路。先规划马的跳点，最后可由马或兵收尾。",
    "explanation": "马先连续调整位置逼近九宫，兵持续封住将的侧路。象和卒的不同应手都无法解除杀网；部分变化也允许改由兵横移完成将杀。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "h5g7",
        "g5e7",
        "g7e6",
        "e7c5",
        "e6c7"
      ],
      [
        "h5g7",
        "g5e7",
        "g7e6",
        "e7c9",
        "e6c7"
      ],
      [
        "h5g7",
        "g5e7",
        "g7e6",
        "e7g5",
        "e6c7"
      ],
      [
        "h5g7",
        "g5e7",
        "g7e6",
        "e7g9",
        "e6c7"
      ],
      [
        "h5g7",
        "g5e7",
        "g7e6",
        "i6i5",
        "e6c7"
      ],
      [
        "h5g7",
        "g5i7",
        "g7e6",
        "i6i5",
        "e6c7"
      ],
      [
        "h5g7",
        "g5i7",
        "g7e6",
        "i7g5",
        "e6c7"
      ],
      [
        "h5g7",
        "g5i7",
        "g7e6",
        "i7g9",
        "e6c7"
      ],
      [
        "h5g7",
        "g5i7",
        "g7f9",
        "i6i5",
        "e8d8"
      ],
      [
        "h5g7",
        "g5i7",
        "g7f9",
        "i7g5",
        "e8d8"
      ],
      [
        "h5g7",
        "g5i7",
        "g7f9",
        "i7g9",
        "e8d8"
      ],
      [
        "h5g7",
        "i6i5",
        "g7e6",
        "g5e7",
        "e6c7"
      ],
      [
        "h5g7",
        "i6i5",
        "g7e6",
        "g5i7",
        "e6c7"
      ],
      [
        "h5g7",
        "i6i5",
        "g7e6",
        "i5i4",
        "e6c7"
      ]
    ]
  },
  {
    "id": "black-pawns-chain",
    "title": "黑方三卒锁宫",
    "theme": "兵卒",
    "difficulty": "进阶",
    "rating": 1450,
    "fen": "5k3/9/9/9/9/9/8P/3p1pp2/4K4/5AB2 b",
    "goal": "mate",
    "maxPlayerMoves": 3,
    "hint": "先用中间的卒逼将移动，算清对方应将后两侧卒怎样接力。",
    "explanation": "三卒配合压缩帅的活动范围。先用中卒将军确定帅的位置，剩下两步依靠相邻卒的互相保护与横向控制完成将杀。",
    "source": {
      "kind": "original",
      "note": "本项目原创编排；采用通用象棋杀法，未复制第三方题库、题解或素材。"
    },
    "solutions": [
      [
        "f2f1",
        "e1e0",
        "d2d1",
        "f0e1",
        "f1e1"
      ],
      [
        "f2f1",
        "e1e0",
        "d2d1",
        "g0i2",
        "f1f0"
      ],
      [
        "f2f1",
        "e1e0",
        "d2d1",
        "i3i4",
        "f1f0"
      ]
    ]
  }
];

export const CCPD_PUZZLES = ccpd.puzzles;
export const PUZZLES = [...ORIGINAL_PUZZLES, ...CCPD_PUZZLES];
