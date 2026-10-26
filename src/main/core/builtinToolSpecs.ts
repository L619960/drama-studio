import type { Skill } from '../../shared/ipcTypes'
import type { ToolSpec } from './llmService'
import { BUILTIN_SKILLS } from './builtinSkills'

const STR_PROP = (desc: string): Record<string, unknown> => ({ type: 'string', description: desc })
/** 按技能 id 取描述（避免数组下标随插入漂移） */
const SKILL_DESC = (id: string): string => {
  const hit = BUILTIN_SKILLS.find(s => s.id === id)
  return hit ? hit.description : ''
}

export const BUILTIN_TOOL_SPECS: Record<string, ToolSpec> = {
  start_director: {
    type: 'function',
    function: {
      name: 'start_director',
      description: SKILL_DESC('builtin-start'),
      parameters: {
        type: 'object',
        properties: {
          title: STR_PROP('片名'),
          genre: { type: 'string', description: '题材，自由填写，不限预设（示例：霸总/重生/悬疑/年代/校园/都市职场/复仇爽剧/科幻/古装……）' },
          script: STR_PROP('完整剧本正文'),
          gate_stages: {
            type: 'array',
            description: '阶段确认点（这些阶段结束后暂停等用户确认）；用户未指定时给 ["analyze","render"]',
            items: {
              type: 'string',
              enum: ['analyze', 'casting', 'scenes', 'render', 'combine', 'subtitle', 'review']
            }
          }
        },
        required: ['title', 'genre', 'script']
      }
    }
  },
  pause_director: { type: 'function', function: { name: 'pause_director', description: SKILL_DESC('builtin-pause'), parameters: { type: 'object', properties: {} } } },
  resume_director: { type: 'function', function: { name: 'resume_director', description: SKILL_DESC('builtin-resume'), parameters: { type: 'object', properties: {} } } },
  cancel_director: { type: 'function', function: { name: 'cancel_director', description: SKILL_DESC('builtin-cancel'), parameters: { type: 'object', properties: {} } } },
  get_director_status: { type: 'function', function: { name: 'get_director_status', description: SKILL_DESC('builtin-status'), parameters: { type: 'object', properties: {} } } },
  list_shots: { type: 'function', function: { name: 'list_shots', description: SKILL_DESC('builtin-shots'), parameters: { type: 'object', properties: {} } } },
  rerender_shots: {
    type: 'function',
    function: {
      name: 'rerender_shots',
      description: SKILL_DESC('builtin-rerender'),
      parameters: {
        type: 'object',
        properties: {
          shot_indexes: { type: 'array', items: { type: 'integer' }, description: '要重新渲染的镜号列表（分镜 index，从 1 开始）' },
          force_rebuild: { type: 'boolean', description: 'true=按最新动作重建首帧并作废审核，重建后须用户再审才能入队（block 门禁下不会直接开渲）' }
        },
        required: ['shot_indexes']
      }
    }
  },
  rerun_casting: {
    type: 'function',
    function: {
      name: 'rerun_casting',
      description: SKILL_DESC('builtin-rerun-casting'),
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  render_sample: {
    type: 'function',
    function: {
      name: 'render_sample',
      description: SKILL_DESC('builtin-sample'),
      parameters: {
        type: 'object',
        properties: {
          shot_indexes: {
            type: 'array',
            items: { type: 'integer' },
            description: '可选：指定试片镜号（2-3 个）。不给则自动挑选不同景别/场景的代表镜头。建议先调用 list_shots 查看分镜再决定。'
          }
        }
      }
    }
  },
  make_trailer: {
    type: 'function',
    function: {
      name: 'make_trailer',
      description: SKILL_DESC('builtin-trailer'),
      parameters: {
        type: 'object',
        properties: {
          shot_indexes: {
            type: 'array',
            items: { type: 'integer' },
            description: '可选：指定高潮镜号（6-10 个）。不给则自动挑选台词情绪强/动作戏的高光镜头。建议先调用 list_shots 查看分镜再决定。'
          },
          clip_seconds: { type: 'number', description: '可选：每段截取秒数，默认 1.5' },
          with_bgm: { type: 'boolean', description: '可选：是否混 BGM，默认 true' }
        }
      }
    }
  },
  get_comfyui_status: { type: 'function', function: { name: 'get_comfyui_status', description: SKILL_DESC('builtin-comfyui'), parameters: { type: 'object', properties: {} } } },
  list_workflows: { type: 'function', function: { name: 'list_workflows', description: SKILL_DESC('builtin-workflows'), parameters: { type: 'object', properties: {} } } },
  choose_workflow: {
    type: 'function',
    function: {
      name: 'choose_workflow',
      description: SKILL_DESC('builtin-choose-workflow'),
      parameters: {
        type: 'object',
        properties: {
          workflow_name: STR_PROP('工作流名称，须与 list_workflows 返回一致'),
          scope: { type: 'string', description: '作用范围：global 全局默认 / project 当前项目默认 / shot 单个分镜', enum: ['global', 'project', 'shot'] },
          shot_index: { type: 'number', description: 'scope=shot 时的分镜镜号（1 起）' }
        },
        required: ['workflow_name']
      }
    }
  },
  get_workflow_params: {
    type: 'function',
    function: {
      name: 'get_workflow_params',
      description: SKILL_DESC('builtin-workflow-params'),
      parameters: {
        type: 'object',
        properties: { workflow_name: STR_PROP('工作流名称') },
        required: ['workflow_name']
      }
    }
  },
  update_workflow_param: {
    type: 'function',
    function: {
      name: 'update_workflow_param',
      description: SKILL_DESC('builtin-workflow-tune'),
      parameters: {
        type: 'object',
        properties: {
          workflow_name: STR_PROP('工作流名称'),
          node_id: STR_PROP('节点 ID'),
          key: STR_PROP('参数名'),
          value: { description: '新值（字符串/数字/布尔，类型与原值一致）' }
        },
        required: ['workflow_name', 'node_id', 'key', 'value']
      }
    }
  },
  create_workflow: {
    type: 'function',
    function: {
      name: 'create_workflow',
      description: SKILL_DESC('builtin-workflow-create'),
      parameters: {
        type: 'object',
        properties: {
          name: STR_PROP('工作流名称（英文或中文，不含扩展名）'),
          content: STR_PROP('ComfyUI API 格式的完整工作流 JSON 文本')
        },
        required: ['name', 'content']
      }
    }
  },
  import_library_workflow: {
    type: 'function',
    function: {
      name: 'import_library_workflow',
      description: SKILL_DESC('builtin-library-import'),
      parameters: {
        type: 'object',
        properties: {
          path: STR_PROP('工作流库内的相对路径（分类/文件名，如 "02.Qwen图片工作流/8.Qwen_2511换脸"；先用 list_workflows 查看 library.categories[].files）')
        },
        required: ['path']
      }
    }
  },
  render_quick: {
    type: 'function',
    function: {
      name: 'render_quick',
      description: SKILL_DESC('builtin-quick-render'),
      parameters: {
        type: 'object',
        properties: {
          workflow_name: STR_PROP('工作流名称（按用户意图自动选：有参考图选 i2v/i2i，纯文字选 t2v/t2i，首尾帧选 flf2v；先用 list_workflows 看 available 的 capability）'),
          prompt: STR_PROP('生成提示词（电影级画面描述：主体/动作/场景/光线/镜头运镜/风格）'),
          ref_image: STR_PROP('参考图绝对路径（图生视频/图生图必填；纯文字生成不传）'),
          end_image: STR_PROP('尾帧图绝对路径（仅首尾帧工作流）'),
          seed: { type: 'number', description: '随机种子（可选，留空自动）' },
          duration_sec: { type: 'number', description: '视频时长（秒，仅视频工作流）' },
          width: { type: 'number', description: '画面宽度（可选，缺省用工作流默认）' },
          height: { type: 'number', description: '画面高度（可选，缺省用工作流默认）' }
        },
        required: ['workflow_name', 'prompt']
      }
    }
  },
  list_memories: {
    type: 'function',
    function: {
      name: 'list_memories',
      description: SKILL_DESC('builtin-memory-list'),
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: '可选分类筛选', enum: ['preference', 'rule', 'lesson'] }
        }
      }
    }
  },
  save_memory: {
    type: 'function',
    function: {
      name: 'save_memory',
      description: SKILL_DESC('builtin-memory-save'),
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'preference=用户偏好，rule=制作规则，lesson=经验教训', enum: ['preference', 'rule', 'lesson'] },
          title: STR_PROP('一句话标题（便于检索，如"台词偏口语化"）'),
          content: STR_PROP('记忆正文，具体、可执行')
        },
        required: ['kind', 'title', 'content']
      }
    }
  },
  // ===== 全功能操作 =====
  list_characters: { type: 'function', function: { name: 'list_characters', description: SKILL_DESC('builtin-characters'), parameters: { type: 'object', properties: {} } } },
  update_character: {
    type: 'function',
    function: {
      name: 'update_character',
      description: SKILL_DESC('builtin-update-character'),
      parameters: {
        type: 'object',
        properties: {
          character_name: STR_PROP('角色名（与角色库一致）'),
          name: STR_PROP('可选：新姓名'),
          description: STR_PROP('可选：新中文简介'),
          voice: STR_PROP('可选：新 TTS 音色（zh-CN-XiaoxiaoNeural / zh-CN-XiaoyiNeural / zh-CN-YunjianNeural / zh-CN-YunyeNeural / zh-CN-YunjieNeural）'),
          voice_rate: { type: 'number', description: '可选：语速百分比，50~200，100 为正常' }
        },
        required: ['character_name']
      }
    }
  },
  update_shot: {
    type: 'function',
    function: {
      name: 'update_shot',
      description: SKILL_DESC('builtin-update-shot'),
      parameters: {
        type: 'object',
        properties: {
          shot_index: { type: 'integer', description: '镜号（1 起）' },
          scene: STR_PROP('可选：新场景名（中文 4~8 字）'),
          action: STR_PROP('可选：新动作提示词（英文 15~40 词，只写动作/镜头/光影，不写外貌）'),
          dialogue: STR_PROP('可选：新台词（空字符串表示删除台词）'),
          type: { type: 'string', description: '可选：镜头类型', enum: ['i2v', 't2v'] },
          shot_size: { type: 'string', description: '可选：景别', enum: ['closeup', 'medium', 'wide'] },
          camera: STR_PROP('可选：英文机位运镜短语'),
          emotion: STR_PROP('可选：英文情绪短语'),
          frames: { type: 'integer', description: '可选：帧数（须满足 16n+1，如 81/97/113）' }
        },
        required: ['shot_index']
      }
    }
  },
  add_shot: {
    type: 'function',
    function: {
      name: 'add_shot',
      description: SKILL_DESC('builtin-add-shot'),
      parameters: {
        type: 'object',
        properties: {
          scene: STR_PROP('场景名（中文 4~8 字）'),
          action: STR_PROP('动作提示词（英文 15~40 词）'),
          dialogue: STR_PROP('台词，无台词传空字符串'),
          type: { type: 'string', description: 'i2v 有人物 / t2v 纯空镜', enum: ['i2v', 't2v'] },
          shot_size: { type: 'string', description: '可选：景别，默认 medium', enum: ['closeup', 'medium', 'wide'] },
          camera: STR_PROP('可选：英文机位运镜短语'),
          emotion: STR_PROP('可选：英文情绪短语'),
          after_index: { type: 'integer', description: '可选：插到第 N 镜之后；不传则追加到末尾' }
        },
        required: ['scene', 'action', 'type']
      }
    }
  },
  delete_shot: {
    type: 'function',
    function: {
      name: 'delete_shot',
      description: SKILL_DESC('builtin-delete-shot'),
      parameters: {
        type: 'object',
        properties: { shot_index: { type: 'integer', description: '要删除的镜号（1 起）' } },
        required: ['shot_index']
      }
    }
  },
  move_shot: {
    type: 'function',
    function: {
      name: 'move_shot',
      description: SKILL_DESC('builtin-move-shot'),
      parameters: {
        type: 'object',
        properties: {
          shot_index: { type: 'integer', description: '要移动的镜号' },
          to_index: { type: 'integer', description: '目标位置（1 起，插入到该镜号位置）' }
        },
        required: ['shot_index', 'to_index']
      }
    }
  },
  list_projects: { type: 'function', function: { name: 'list_projects', description: SKILL_DESC('builtin-projects'), parameters: { type: 'object', properties: {} } } },
  open_project: {
    type: 'function',
    function: {
      name: 'open_project',
      description: SKILL_DESC('builtin-open-project'),
      parameters: {
        type: 'object',
        properties: { title: STR_PROP('项目片名（与 list_projects 返回一致）') },
        required: ['title']
      }
    }
  },
  get_settings: { type: 'function', function: { name: 'get_settings', description: SKILL_DESC('builtin-settings'), parameters: { type: 'object', properties: {} } } },
  set_settings: {
    type: 'function',
    function: {
      name: 'set_settings',
      description: SKILL_DESC('builtin-update-settings'),
      parameters: {
        type: 'object',
        properties: {
          workflow_default: STR_PROP('默认视频生成工作流名，如 wan22_i2v / minimax_h3_i2v'),
          render: {
            type: 'object',
            description: '渲染参数（可选字段局部更新，未传字段保持不变）',
            properties: {
              defaultWidth: { type: 'number', description: '默认首帧宽度' },
              defaultHeight: { type: 'number', description: '默认首帧高度' },
              defaultFrames: { type: 'number', description: '默认帧数（须满足 16n+1）' },
              timeout: { type: 'number', description: '单镜渲染超时秒数' },
              lipSync: { type: 'boolean', description: '是否启用口型同步' },
              lipSyncMode: { type: 'string', enum: ['auto', 'local', 'off'], description: '口型模式' },
              oomRetry: { type: 'boolean', description: '显存不足自动降档重试' },
              consistencyMode: { type: 'string', enum: ['off', 'warn', 'rerender'], description: '一致性校验模式。rerender=低分换种子重渲一次；warn=只打标仍入成片；off=不校验' },
              resolutionTier: { type: 'string', enum: ['auto', 'low', 'mid', 'standard', 'high', 'ultra'], description: '显存档位' }
            }
          },
          comfyui_baseUrl: STR_PROP('ComfyUI 服务地址，如 http://127.0.0.1:8188'),
          tts_defaultVoice: STR_PROP('TTS 音色名，如 zh-CN-XiaoxiaoNeural'),
          tts_rate: { type: 'number', description: 'TTS 语速（50-200）' },
          llm_model: STR_PROP('LLM 模型名'),
          llm_baseUrl: STR_PROP('LLM API 基础地址')
        }
      }
    }
  },
  set_project_bgm: {
    type: 'function',
    function: {
      name: 'set_project_bgm',
      description: SKILL_DESC('builtin-set-bgm'),
      parameters: {
        type: 'object',
        properties: {
          absolute_path: STR_PROP('BGM 音频文件的绝对路径（mp3/wav/m4a/aac/ogg）'),
          volume: { type: 'number', description: '可选：混音音量 0-100，默认 35' }
        },
        required: ['absolute_path']
      }
    }
  },
  list_project_files: { type: 'function', function: { name: 'list_project_files', description: SKILL_DESC('builtin-files'), parameters: { type: 'object', properties: {} } } },
  open_file: {
    type: 'function',
    function: {
      name: 'open_file',
      description: SKILL_DESC('builtin-open-file'),
      parameters: {
        type: 'object',
        properties: { relative_path: STR_PROP('项目内文件的相对路径（list_project_files 返回的 path）') },
        required: ['relative_path']
      }
    }
  },
  // ===== 网络自主学习 =====
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: SKILL_DESC('builtin-web-search'),
      parameters: {
        type: 'object',
        properties: { query: STR_PROP('搜索关键词（可用中文或英文）') },
        required: ['query']
      }
    }
  },
  fetch_url: {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: SKILL_DESC('builtin-fetch-url'),
      parameters: {
        type: 'object',
        properties: { url: STR_PROP('完整网址（http/https）') },
        required: ['url']
      }
    }
  },
  create_skill: {
    type: 'function',
    function: {
      name: 'create_skill',
      description: SKILL_DESC('builtin-create-skill'),
      parameters: {
        type: 'object',
        properties: {
          name: STR_PROP('技能名（简短中文，如"悬疑片拆镜法"）'),
          description: STR_PROP('一句话说明何时使用该技能'),
          prompt_template: STR_PROP('完整提示词模板，用户输入以 {{input}} 占位符嵌入')
        },
        required: ['name', 'description', 'prompt_template']
      }
    }
  },
  list_skills: { type: 'function', function: { name: 'list_skills', description: SKILL_DESC('builtin-list-skills'), parameters: { type: 'object', properties: {} } } },
  update_skill: {
    type: 'function',
    function: {
      name: 'update_skill',
      description: SKILL_DESC('builtin-update-skill'),
      parameters: {
        type: 'object',
        properties: {
          skill_id: STR_PROP('技能 id（来自 list_skills 返回）'),
          name: STR_PROP('可选：新技能名'),
          description: STR_PROP('可选：新的用途说明'),
          prompt_template: STR_PROP('可选：新提示词模板，须包含 {{input}} 占位符')
        },
        required: ['skill_id']
      }
    }
  }
}

/** 自定义提示词技能的统一工具 schema（运行时按技能生成） */
export function customToolSpec(skill: Skill): ToolSpec {
  return {
    type: 'function',
    function: {
      name: `custom_${skill.id}`,
      description: skill.description,
      parameters: {
        type: 'object',
        properties: { user_text: STR_PROP('用户针对该技能的具体要求或素材') },
        required: ['user_text']
      }
    }
  }
}
