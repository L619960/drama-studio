<template>
  <div class="console">
    <!-- ===== 左栏：模块导航 + 项目概览 ===== -->
    <aside class="console-aside">
      <div class="aside-title">导演控制台</div>
      <el-menu :default-active="activeModule" class="aside-menu" @select="onModuleSelect">
        <el-menu-item index="workflow">
          <el-icon><DataLine /></el-icon><span>工作流监控</span>
        </el-menu-item>
        <el-menu-item index="skills">
          <el-icon><MagicStick /></el-icon><span>技能管理</span>
        </el-menu-item>
        <el-menu-item index="memory">
          <el-icon><Collection /></el-icon><span>记忆库</span>
        </el-menu-item>
        <el-menu-item index="comfyui">
          <el-icon><Cpu /></el-icon><span>ComfyUI</span>
        </el-menu-item>
      </el-menu>

      <div v-if="state" class="aside-project">
        <div class="aside-subtitle">项目概览</div>
        <div class="kv"><span class="k">片名</span><span class="v">{{ state.title }}</span></div>
        <div class="kv">
          <span class="k">镜头</span>
          <span class="v">{{ state.doneShots }}/{{ state.totalShots }} 完成
            <el-tag v-if="state.failedShotIds.length" size="small" type="danger" effect="plain">
              {{ state.failedShotIds.length }} 失败
            </el-tag>
          </span>
        </div>
        <div v-if="state.reviewIssues?.length" class="review-issues">
          <div class="aside-subtitle">复审问题</div>
          <div v-for="(iss, i) in state.reviewIssues.slice(0, 5)" :key="i" class="issue-item">{{ iss }}</div>
        </div>
        <div v-if="state.finalPath" class="final-path">
          <el-button size="small" @click="openFinalFolder">
            <el-icon><FolderOpened /></el-icon>&nbsp;成片所在目录
          </el-button>
        </div>
      </div>
    </aside>

    <!-- ===== 中栏 ===== -->
    <section class="console-main">
      <!-- 模块一：工作流监控 -->
      <template v-if="activeModule === 'workflow'">
        <header class="control-bar">
          <div class="control-title">
            <span v-if="state">{{ state.title }}</span>
            <span v-else>导演工作台</span>
            <el-tag v-if="paused" type="warning" effect="dark" size="small" class="state-tag">已暂停 · 等待确认</el-tag>
            <el-tag v-else-if="running" type="primary" effect="dark" size="small" class="state-tag">执行中</el-tag>
            <el-tag v-else-if="state" type="success" effect="plain" size="small" class="state-tag">已结束</el-tag>
            <el-tag v-else type="info" effect="plain" size="small" class="state-tag">待命</el-tag>
          </div>
          <div class="control-actions">
            <el-button v-if="!running" type="primary" :icon="VideoPlay" @click="openStartDialog">开始任务</el-button>
            <template v-else>
              <el-button v-if="!paused" type="warning" :icon="VideoPause" @click="onPause">暂停</el-button>
              <el-button v-else type="success" :icon="VideoPlay" @click="onResume">继续</el-button>
              <el-button type="danger" :icon="Close" @click="onCancel">取消任务</el-button>
            </template>
          </div>
        </header>

        <el-alert
          v-if="paused"
          class="pause-alert"
          type="warning"
          :closable="false"
          show-icon
          title="任务已停在阶段确认点"
          description="进行中的渲染已安全完成，流水线已挂起。检查产物无误后点「继续」进入下一阶段，或点「取消任务」终止。"
        />

        <!-- 九阶段时间线 -->
        <div class="panel">
          <div class="panel-title">工作流阶段</div>
          <div class="stage-list">
            <div
              v-for="stage in stageOrder"
              :key="stage"
              class="stage-row"
              :class="[`is-${state?.stages[stage]?.status || 'pending'}`]"
            >
              <div class="stage-icon">
                <el-icon v-if="state?.stages[stage]?.status === 'running'" class="is-loading"><Loading /></el-icon>
                <el-icon v-else-if="state?.stages[stage]?.status === 'done'"><CircleCheckFilled /></el-icon>
                <el-icon v-else-if="state?.stages[stage]?.status === 'error'"><CircleCloseFilled /></el-icon>
                <el-icon v-else-if="state?.stages[stage]?.status === 'skipped'"><RemoveFilled /></el-icon>
                <el-icon v-else-if="isGate(stage)"><Timer /></el-icon>
                <el-icon v-else><MoreFilled /></el-icon>
              </div>
              <div class="stage-body">
                <div class="stage-head">
                  <span class="stage-name">{{ stageLabels[stage] }}</span>
                  <el-tag v-if="isGate(stage)" size="small" type="warning" effect="plain" class="gate-tag">阶段后暂停</el-tag>
                </div>
                <div v-if="state?.stages[stage]?.message" class="stage-msg">{{ state.stages[stage].message }}</div>
                <el-progress
                  v-if="state?.stages[stage]?.status === 'running'"
                  :percentage="state.stages[stage].percent"
                  :stroke-width="4"
                  :show-text="false"
                  class="stage-progress"
                />
              </div>
            </div>
          </div>
        </div>

        <!-- 中文执行日志（按阶段自动折叠） -->
        <div class="panel panel-grow">
          <div class="panel-title log-title">
            执行日志
            <span class="log-hint">已完成阶段自动折叠 · 新消息自动滚底</span>
          </div>
          <div ref="logBoxRef" class="log-box">
            <el-collapse v-if="logsByStage.length" v-model="expandedStages" class="log-collapse">
              <el-collapse-item
                v-for="group in logsByStage"
                :key="group.stage"
                :name="group.stage"
              >
                <template #title>
                  <span class="log-group-title">{{ stageLabels[group.stage] }}</span>
                  <el-tag size="small" :type="groupHasError(group) ? 'danger' : 'info'" effect="plain" class="log-count">
                    {{ group.entries.length }} 条
                  </el-tag>
                </template>
                <div v-for="entry in group.entries" :key="entry.id" class="log-entry">
                  <span class="log-time">{{ formatTime(entry.timestamp) }}</span>
                  <span class="log-level" :class="`lv-${entry.level}`">{{ levelText[entry.level] }}</span>
                  <span class="log-msg">{{ entry.message }}</span>
                </div>
              </el-collapse-item>
            </el-collapse>
            <el-empty v-else description="暂无日志，开始任务后在此实时显示" :image-size="80" />
          </div>
        </div>
      </template>

      <!-- 模块二：技能管理 -->
      <template v-else-if="activeModule === 'skills'">
        <div class="panel panel-fill">
          <div class="panel-title skills-title">
            技能管理
            <el-button type="primary" size="small" :icon="Plus" @click="openSkillDialog()">新建技能</el-button>
          </div>
          <p class="skills-tip">
            技能是导演在对话中可调用的能力。<b>内置操作</b>绑定真实功能（开拍、暂停、重渲等），开关即授权；
            <b>自定义技能</b>是提示词模板，可把你的常用指令沉淀为一键能力，模板中用
            <code v-text="'{{input}}'" /> 代表对话里的具体要求。
          </p>
          <div class="skill-list">
            <div v-for="s in skills" :key="s.id" class="skill-item">
              <div class="skill-main">
                <div class="skill-head">
                  <span class="skill-name">{{ s.name }}</span>
                  <el-tag size="small" :type="s.builtin ? 'success' : 'warning'" effect="plain">
                    {{ s.builtin ? '内置操作' : '自定义' }}
                  </el-tag>
                </div>
                <div class="skill-desc">{{ s.description }}</div>
              </div>
              <div class="skill-ops">
                <el-button v-if="!s.builtin" link size="small" :icon="EditPen" @click="openSkillDialog(s)">编辑</el-button>
                <el-button v-if="!s.builtin" link size="small" type="danger" :icon="Delete" @click="removeSkill(s)">删除</el-button>
                <el-switch :model-value="s.enabled" @change="(v: boolean) => toggleSkill(s, v)" />
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- 模块三：记忆库 -->
      <template v-else-if="activeModule === 'memory'">
        <div class="panel panel-fill">
          <div class="panel-title skills-title">
            导演记忆库
            <el-button type="primary" size="small" :icon="Plus" @click="openMemoryDialog()">新增记忆</el-button>
          </div>
          <p class="skills-tip">
            跨项目长期记忆，会在每次对话时注入导演的系统上下文：<b>用户偏好</b>是你的创作喜好，
            <b>制作规则</b>是拆镜与生产规范，<b>经验教训</b>是踩坑后沉淀的避坑要点。导演在对话中也会用「沉淀记忆」技能自动记录。
          </p>
          <el-tabs v-model="memoryKind" class="memory-tabs">
            <el-tab-pane v-for="k in memoryKindOptions" :key="k.value" :name="k.value">
              <template #label>{{ k.label }}（{{ memoryCountOf(k.value) }}）</template>
            </el-tab-pane>
          </el-tabs>
          <div class="skill-list">
            <div v-for="m in filteredMemories" :key="m.id" class="skill-item memory-item">
              <div class="skill-main">
                <div class="skill-head">
                  <span class="skill-name">{{ m.title }}</span>
                </div>
                <div class="memory-content">{{ m.content }}</div>
                <div class="memory-time">更新于 {{ formatDateTime(m.updatedAt) }}</div>
              </div>
              <div class="skill-ops">
                <el-button link size="small" :icon="EditPen" @click="openMemoryDialog(m)">编辑</el-button>
                <el-button link size="small" type="danger" :icon="Delete" @click="removeMemory(m)">删除</el-button>
              </div>
            </div>
            <el-empty v-if="!filteredMemories.length" :image-size="70" description="暂无记忆，新增一条或让导演在对话中沉淀" />
          </div>
        </div>
      </template>

      <!-- 模块四：ComfyUI 控制面板 -->
      <template v-else-if="activeModule === 'comfyui'">
        <div class="panel panel-fill comfy-panel">
          <div class="panel-title skills-title">
            ComfyUI 完全控制
            <el-button size="small" :icon="Refresh" :loading="comfyLoading" @click="refreshComfy">刷新</el-button>
          </div>

          <div class="comfy-cards">
            <!-- 服务状态 -->
            <div class="comfy-card">
              <div class="comfy-card-title">服务状态</div>
              <div v-if="comfyStats" class="comfy-card-body">
                <div class="kv"><span class="k">连接</span>
                  <span class="v"><el-tag size="small" type="success" effect="dark">在线</el-tag></span>
                </div>
                <div class="kv"><span class="k">版本</span><span class="v">ComfyUI {{ comfyStats.version || '未知' }}</span></div>
                <div class="kv"><span class="k">Python</span><span class="v">{{ comfyStats.pythonVersion || '未知' }}</span></div>
                <div class="kv"><span class="k">节点类</span><span class="v">{{ nodeNames.length }} 个已安装</span></div>
              </div>
              <div v-else class="comfy-offline">
                <el-tag size="small" type="danger" effect="dark">无法连接</el-tag>
                <span class="muted">请确认 ComfyUI 已启动（默认 http://127.0.0.1:8188）</span>
              </div>
            </div>

            <!-- GPU / 显存 -->
            <div class="comfy-card">
              <div class="comfy-card-title">GPU 与显存</div>
              <div v-if="comfyStats?.devices.length" class="comfy-card-body">
                <div v-for="(d, i) in comfyStats.devices" :key="i" class="gpu-block">
                  <div class="gpu-name">{{ gpuLabel(d) }}</div>
                  <el-progress
                    :percentage="vramPercent(d)"
                    :stroke-width="12"
                    :status="vramPercent(d) > 90 ? 'exception' : undefined"
                  />
                  <div class="gpu-vram">{{ gb(d.vramTotal - d.vramFree) }} / {{ gb(d.vramTotal) }} GB 已用 · 剩余 {{ gb(d.vramFree) }} GB</div>
                </div>
              </div>
              <div v-else class="muted comfy-card-body">{{ comfyStats ? '未返回设备信息' : '离线状态下无数据' }}</div>
            </div>
          </div>

          <!-- 节点探测 -->
          <div class="comfy-card">
            <div class="comfy-card-title">节点健康探测</div>
            <el-input
              v-model="nodeQuery"
              size="small"
              placeholder="输入节点类名关键字，如 Wan / LatentSync / VAE"
              clearable
              class="node-search"
            />
            <div v-if="nodeQuery && nodeNames.length" class="node-matches">
              <el-tag
                v-for="n in matchedNodes.slice(0, 30)"
                :key="n"
                size="small"
                :type="n.toLowerCase() === nodeQuery.toLowerCase() ? 'success' : 'info'"
                effect="plain"
                class="node-tag"
              >{{ n }}</el-tag>
              <div v-if="!matchedNodes.length" class="muted">没有匹配的已安装节点（可能缺自定义节点包）</div>
              <div v-if="matchedNodes.length > 30" class="muted">…仅显示前 30 个（共 {{ matchedNodes.length }} 个匹配）</div>
            </div>
          </div>

          <!-- 工作流环境自检 -->
          <div class="comfy-card">
            <div class="comfy-card-title">
              工作流环境自检
              <el-button size="small" type="primary" plain :loading="validateLoading" @click="runValidate">
                {{ validateRun ? '重新自检' : '开始自检' }}
              </el-button>
            </div>
            <div v-if="!validateRun" class="muted">
              检查全部工作流模板需要的自定义节点与模型文件是否齐全（渲染前也会自动拦截缺失项）
            </div>
            <template v-else>
              <el-alert
                v-if="validateBadCount === 0"
                type="success"
                :closable="false"
                title="全部工作流环境就绪，未发现缺失节点或模型"
                style="margin-bottom: 10px"
              />
              <el-alert
                v-else
                type="error"
                :closable="false"
                :title="`发现 ${validateBadCount} 个问题（将在渲染时被拦截）`"
                style="margin-bottom: 10px"
              />
              <div v-for="r in validateReports.filter(x => !x.ok)" :key="r.workflow" class="validate-block">
                <div class="validate-wf">{{ r.workflow }}</div>
                <div v-for="(iss, i) in r.issues" :key="i" class="validate-issue">
                  <el-tag size="small" :type="iss.kind === 'missing-node' ? 'danger' : 'warning'" effect="dark">
                    {{ iss.kind === 'missing-node' ? '缺节点' : '缺模型' }}
                  </el-tag>
                  <span>{{ iss.message }}</span>
                </div>
              </div>
            </template>
          </div>

          <!-- 工作流模板 -->
          <div class="comfy-card">
            <div class="comfy-card-title">工作流模板与参数</div>
            <el-collapse v-model="expandedWorkflows" class="wf-collapse" @change="onWfExpand">
              <el-collapse-item v-for="w in workflows" :key="w.name" :name="w.name">
                <template #title>
                  <span class="wf-name">{{ w.name }}</span>
                  <el-tag size="small" type="success" effect="plain" v-if="w.hasImageInput">图生视频</el-tag>
                  <el-tag size="small" type="primary" effect="plain" v-else>纯文生</el-tag>
                  <el-tag size="small" type="warning" effect="plain" v-if="w.hasDuration">时长参数</el-tag>
                </template>
                <div class="wf-params">
                  <div v-for="p in workflowParams[w.name] || []" :key="`${p.nodeId}.${p.key}`" class="wf-param">
                    <div class="wf-param-label">
                      <span class="wf-param-title">{{ p.nodeTitle }} · {{ p.key }}</span>
                      <span class="wf-param-class">{{ p.classType }}</span>
                    </div>
                    <div class="wf-param-input">
                      <el-switch
                        v-if="p.type === 'boolean' && canEditParam(p)"
                        :model-value="Boolean(p.value)"
                        @change="(v: boolean) => updateWfParam(w.name, p, v)"
                      />
                      <el-input-number
                        v-else-if="p.type === 'number' && canEditParam(p)"
                        :model-value="Number(p.value)"
                        size="small"
                        controls-position="right"
                        @change="(v?: number) => updateWfParam(w.name, p, v ?? 0)"
                      />
                      <el-input
                        v-else-if="canEditParam(p)"
                        :model-value="String(p.value)"
                        size="small"
                        @change="(v: string) => updateWfParam(w.name, p, v)"
                      />
                      <el-tag v-else size="small" type="info" effect="plain">
                        {{ p.isConnection ? '节点连接' : '占位符（运行时注入）' }}
                      </el-tag>
                    </div>
                  </div>
                </div>
              </el-collapse-item>
            </el-collapse>
          </div>
        </div>
      </template>
    </section>

    <!-- ===== 右栏：导演真实对话 ===== -->
    <aside class="console-right">
      <div class="panel chat-panel">
        <div class="panel-title chat-title">
          <span class="chat-title-text"><el-icon><ChatDotRound /></el-icon>&nbsp;导演对话</span>
          <el-button link size="small" :icon="Delete" class="chat-clear" @click="clearChat">清空</el-button>
        </div>

        <div ref="chatBoxRef" class="chat-box">
          <div v-if="!messages.length" class="chat-empty">
            <el-icon class="chat-empty-icon"><ChatLineSquare /></el-icon>
            <p>和导演说句话吧：开拍、查进度、暂停继续、重渲镜头都可以。</p>
            <div class="quick-chips">
              <el-tag
                v-for="q in quickPrompts"
                :key="q"
                class="quick-chip"
                effect="plain"
                @click="useQuick(q)"
              >{{ q }}</el-tag>
            </div>
          </div>

          <div
            v-for="m in messages"
            :key="m.id"
            class="msg-row"
            :class="[m.role === 'user' ? 'is-user' : 'is-assistant', { 'is-error': m.error }]"
          >
            <div v-if="m.role === 'user'" class="msg-user-wrap">
              <div class="bubble bubble-user">{{ m.content }}</div>
              <div class="msg-user-foot">
                <span class="msg-time">{{ formatTime(m.ts) }}</span>
                <span class="msg-op" title="复制" @click="copyMsg(m.content)"><el-icon><CopyDocument /></el-icon></span>
                <span class="msg-op" title="重新发送" @click="resendMsg(m)"><el-icon><Refresh /></el-icon></span>
              </div>
            </div>
            <div v-else class="bubble bubble-assistant">
              <div v-if="m.content" class="msg-text msg-actionable" v-html="renderMd(m.content)" @contextmenu.prevent="copyMsg(m.content)" />
              <div v-if="m.toolCalls?.length" class="tool-list">
                <div
                  v-for="tc in m.toolCalls"
                  :key="tc.id"
                  class="tool-card"
                  :class="`is-${tc.status}`"
                >
                  <div class="tool-head" @click="toggleTool(tc.id)">
                    <el-icon v-if="tc.status === 'running'" class="tool-icon is-loading"><Loading /></el-icon>
                    <el-icon v-else-if="tc.status === 'done'" class="tool-icon tc-done"><CircleCheckFilled /></el-icon>
                    <el-icon v-else class="tool-icon tc-error"><CircleCloseFilled /></el-icon>
                    <span class="tool-label">{{ tc.label }}</span>
                    <span v-if="tc.argsText" class="tool-args">{{ tc.argsText }}</span>
                    <el-icon v-if="tc.result" class="tool-caret"><CaretBottom /></el-icon>
                  </div>
                  <div v-if="tc.result && expandedTools.has(tc.id)" class="tool-result">
                    <pre>{{ tc.result }}</pre>
                  </div>
                </div>
              </div>
              <div class="msg-foot">
                <span class="msg-time">{{ formatTime(m.ts) }}</span>
                <span class="msg-op" title="复制" @click="copyMsg(m.content)"><el-icon><CopyDocument /></el-icon></span>
              </div>
            </div>
          </div>

          <div v-if="sending" class="msg-row is-assistant">
            <div class="bubble bubble-assistant typing">
              <el-icon class="is-loading"><Loading /></el-icon><span>导演思考中…</span>
            </div>
          </div>
        </div>

        <div class="chat-input">
          <el-input
            v-model="inputText"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 4 }"
            placeholder="给导演下达指令，Enter 发送 / Shift+Enter 换行"
            :disabled="sending"
            @keydown.enter.exact.prevent="sendMessage"
          />
          <el-button type="primary" circle :icon="Promotion" :loading="sending" @click="sendMessage" />
        </div>
      </div>
    </aside>

    <!-- ===== 开拍需求确认弹窗 ===== -->
    <el-dialog v-model="startDialogVisible" title="开拍需求确认" width="640px" :close-on-click-modal="false">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        class="confirm-tip"
        title="导演将按以下配置全自动执行：拆镜 → 定妆/首帧 → 逐镜渲染与审批 → 拼接 → 字幕 → 复审 → BGM"
        description="勾选的阶段结束后流水线会暂停，等你检查确认再继续；不勾选则一口气跑完。"
      />
      <el-form label-width="92px" class="start-form">
        <el-form-item label="片名" required>
          <el-input v-model="startForm.title" maxlength="40" placeholder="例如：雨夜重逢" />
        </el-form-item>
        <el-form-item label="题材" required>
          <el-select v-model="startForm.genre" style="width: 200px">
            <el-option v-for="g in GENRE_TEMPLATES" :key="g.key" :label="g.label" :value="g.key" />
          </el-select>
        </el-form-item>
        <el-form-item label="剧本" required>
          <el-input
            v-model="startForm.script"
            type="textarea"
            :rows="7"
            placeholder="粘贴剧本正文，包含场景描述与角色台词…"
          />
        </el-form-item>
        <el-form-item label="确认点">
          <el-checkbox-group v-model="startForm.gateStages" class="gate-checks">
            <el-checkbox v-for="g in gateOptions" :key="g.value" :label="g.value">
              {{ g.label }}完成后暂停
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="startDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="starting" @click="confirmStart">确认开拍</el-button>
      </template>
    </el-dialog>

    <!-- ===== 自定义技能编辑弹窗 ===== -->
    <el-dialog v-model="skillDialog.visible" :title="editingSkill ? '编辑技能' : '新建技能'" width="560px" :close-on-click-modal="false">
      <el-form label-width="84px">
        <el-form-item label="技能名称" required>
          <el-input v-model="skillDialog.name" maxlength="20" show-word-limit placeholder="例如：古风润色师" />
        </el-form-item>
        <el-form-item label="能力说明" required>
          <el-input
            v-model="skillDialog.description"
            type="textarea"
            :rows="2"
            maxlength="120"
            show-word-limit
            placeholder="告诉导演什么时候该用这个技能"
          />
        </el-form-item>
        <el-form-item label="提示词模板">
          <el-input
            v-model="skillDialog.promptTemplate"
            type="textarea"
            :rows="7"
            placeholder="例如：你是资深古风编剧，请把用户的台词改写为半文言风格，保留原意。用户要求：{{input}}"
          />
        </el-form-item>
        <div class="skill-dialog-hint">用 <code v-text="'{{input}}'" /> 引用对话里的具体要求；导演调用时会按模板走一次大模型生成。</div>
      </el-form>
      <template #footer>
        <el-button @click="skillDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="skillSaving" @click="saveSkill">保存</el-button>
      </template>
    </el-dialog>

    <!-- ===== 记忆编辑弹窗 ===== -->
    <el-dialog v-model="memoryDialog.visible" :title="editingMemory ? '编辑记忆' : '新增记忆'" width="560px" :close-on-click-modal="false">
      <el-form label-width="84px">
        <el-form-item label="分类" required>
          <el-select v-model="memoryDialog.kind" style="width: 200px">
            <el-option v-for="k in memoryKindOptions" :key="k.value" :label="k.label" :value="k.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题" required>
          <el-input v-model="memoryDialog.title" maxlength="30" show-word-limit placeholder="一句话标题，如：台词偏口语化" />
        </el-form-item>
        <el-form-item label="内容" required>
          <el-input
            v-model="memoryDialog.content"
            type="textarea"
            :rows="6"
            maxlength="500"
            show-word-limit
            placeholder="具体、可执行的记忆内容"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="memoryDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="memorySaving" @click="saveMemory">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  VideoPlay, VideoPause, Close, DataLine, MagicStick, Collection, Cpu,
  Loading, CircleCheckFilled, CircleCloseFilled, RemoveFilled, MoreFilled, Timer,
  FolderOpened, ChatDotRound, ChatLineSquare,
  Plus, EditPen, Delete, Promotion, CaretBottom, Refresh, CopyDocument
} from '@element-plus/icons-vue'
import {
  GENRE_TEMPLATES,
  type DirectorState, type DirectorStage, type DirectorLogEntry,
  type Skill, type ConversationMessage, type ConversationToolEvent,
  type MemoryItem, type MemoryKind,
  type ComfySystemStats, type ComfyGpuDevice,
  type WorkflowMeta, type WorkflowParam, type WorkflowCheckReport
} from '../../../shared/ipcTypes'

const route = useRoute()
const router = useRouter()
const projectId = computed(() => route.params.id as string | undefined)
/** 对话作用域：项目内对话带项目快照；无项目时为全局对话 */
const chatScope = computed(() => projectId.value || 'global')

const stageOrder: DirectorStage[] = [
  'analyze', 'casting', 'scenes', 'render',
  'combine', 'subtitle', 'review', 'bgm', 'done'
]
const stageLabels: Record<DirectorStage, string> = {
  analyze: '剧本分析',
  casting: '角色建档',
  scenes: '场景与首帧',
  render: '逐镜渲染 · 审批',
  combine: '拼接成片',
  subtitle: '烧录字幕',
  review: '成片复审',
  bgm: 'BGM 混音',
  done: '完成'
}
const levelText = { info: '信息', success: '成功', warn: '警告', error: '错误' } as const
const gateOptions = [
  { value: 'analyze', label: '剧本分析（核对角色与分镜）' },
  { value: 'casting', label: '角色建档（核设定妆照）' },
  { value: 'scenes', label: '场景与首帧（核对全部首帧图）' },
  { value: 'render', label: '逐镜渲染与审批' },
  { value: 'combine', label: '拼接成片' },
  { value: 'subtitle', label: '烧录字幕' },
  { value: 'review', label: '成片复审（配乐前最后一关）' }
] as const

const activeModule = ref('workflow')
const state = ref<DirectorState | null>(null)
const localLogs = ref<DirectorLogEntry[]>([])
const expandedStages = ref<DirectorStage[]>(['analyze'])
const logBoxRef = ref<HTMLElement | null>(null)

const running = computed(() => state.value?.running ?? false)
const paused = computed(() => state.value?.paused ?? false)
const currentProjectId = computed(() => state.value?.projectId || projectId.value)

const logsByStage = computed(() => {
  const map = new Map<DirectorStage, DirectorLogEntry[]>()
  for (const e of localLogs.value) {
    const arr = map.get(e.stage) || []
    arr.push(e)
    map.set(e.stage, arr)
  }
  return stageOrder
    .filter(s => map.has(s))
    .map(stage => ({ stage, entries: map.get(stage)! }))
})

function isGate(stage: DirectorStage): boolean {
  return state.value?.gateStages.includes(stage) ?? false
}
function groupHasError(g: { entries: DirectorLogEntry[] }): boolean {
  return g.entries.some(e => e.level === 'error')
}
function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

// 合并日志（按 id 去重，保持顺序）
function mergeLogs(entries: DirectorLogEntry[]): void {
  if (!entries.length) return
  const known = new Set(localLogs.value.map(e => e.id))
  let changed = false
  for (const e of entries) {
    if (!known.has(e.id)) {
      localLogs.value.push(e)
      known.add(e.id)
      changed = true
    }
  }
  if (changed && localLogs.value.length > 300) {
    localLogs.value = localLogs.value.slice(-300)
  }
}

// 阶段切换时：自动展开运行中/出错阶段，收起已完成阶段
let lastRunning = ''
watch(() => {
  const s = state.value
  if (!s) return ''
  const cur = stageOrder.find(st => s.stages[st].status === 'running') || ''
  return `${cur}|${s.paused}`
}, (sig) => {
  const [cur, pausedFlag] = sig.split('|')
  const next = new Set(expandedStages.value)
  if (lastRunning && lastRunning !== cur) {
    const prev = state.value?.stages[lastRunning as DirectorStage]
    if (prev && prev.status !== 'error') next.delete(lastRunning as DirectorStage)
  }
  if (cur) next.add(cur as DirectorStage)
  if (pausedFlag === 'true' && cur === '') {
    const last = logsByStage.value[logsByStage.value.length - 1]
    if (last) next.add(last.stage)
  }
  expandedStages.value = [...next]
  lastRunning = cur
})

// 新日志自动滚底（用户正在回看历史时不打断）
watch(() => localLogs.value.length, async () => {
  await nextTick()
  const box = logBoxRef.value
  if (!box) return
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140
  if (nearBottom) box.scrollTop = box.scrollHeight
})

let unsubProgress: (() => void) | null = null
let unsubLog: (() => void) | null = null
let unsubTool: (() => void) | null = null

onMounted(async () => {
  if (projectId.value) await hydrate(projectId.value)
  await loadSkills()
  await loadMemories()
  await loadChat()

  unsubProgress = window.api.director.onProgress((e) => {
    if (currentProjectId.value && e.projectId !== currentProjectId.value) return
    state.value = e.state
    mergeLogs(e.state.logs || [])
  })
  unsubLog = window.api.director.onLog((e) => {
    if (currentProjectId.value && e.projectId !== currentProjectId.value) return
    mergeLogs([e.entry])
  })
  unsubTool = window.api.conversation.onToolEvent(applyToolEvent)
})

onUnmounted(() => {
  unsubProgress?.()
  unsubLog?.()
  unsubTool?.()
})

// 路由项目切换：同一组件复用时重新装载
watch(projectId, async (id, old) => {
  if (id === old) return
  state.value = null
  localLogs.value = []
  if (id) await hydrate(id)
  await loadChat()
})

async function hydrate(id: string): Promise<void> {
  const s = await window.api.director.getState(id)
  if (!s) return
  state.value = s
  mergeLogs(s.logs || [])
  const cur = stageOrder.find(st => s.stages[st].status === 'running')
  if (cur) expandedStages.value = [cur]
}

function onModuleSelect(index: string): void {
  activeModule.value = index
}

// ===== 任务控制 =====
async function onPause(): Promise<void> {
  if (!currentProjectId.value) return
  await window.api.director.pause(currentProjectId.value)
  ElMessage.info('已请求暂停，当前阶段结束后自动停下')
}
async function onResume(): Promise<void> {
  if (!currentProjectId.value) return
  await window.api.director.resume(currentProjectId.value)
}
async function onCancel(): Promise<void> {
  if (!currentProjectId.value) return
  try {
    await ElMessageBox.confirm('确定取消当前任务吗？未完成的渲染结果会保留，但流水线将终止。', '取消任务', {
      type: 'warning',
      confirmButtonText: '取消任务',
      cancelButtonText: '再想想'
    })
  } catch { return }
  await window.api.director.cancel(currentProjectId.value)
  ElMessage.warning('任务取消中')
}
async function openFinalFolder(): Promise<void> {
  if (state.value?.finalPath) await window.api.shell.showItem(state.value.finalPath)
}

// ===== 开拍需求确认 =====
const startDialogVisible = ref(false)
const starting = ref(false)
const startForm = ref({
  title: '',
  genre: '霸总',
  script: '',
  gateStages: ['analyze', 'render'] as DirectorStage[]
})

function openStartDialog(): void {
  startForm.value = {
    title: startForm.value.title || '',
    genre: startForm.value.genre || '霸总',
    script: startForm.value.script || '',
    gateStages: ['analyze', 'render']
  }
  startDialogVisible.value = true
}

async function confirmStart(): Promise<void> {
  if (!startForm.value.title.trim()) { ElMessage.warning('请填写片名'); return }
  if (!startForm.value.script.trim()) { ElMessage.warning('请粘贴剧本正文'); return }
  starting.value = true
  try {
    const newId = await window.api.director.start({
      title: startForm.value.title.trim(),
      genre: startForm.value.genre,
      script: startForm.value.script.trim(),
      gateStages: startForm.value.gateStages
    })
    startDialogVisible.value = false
    localLogs.value = []
    ElMessage.success('任务已启动')
    if (!projectId.value || projectId.value !== newId) {
      router.replace(`/project/${newId}/console`)
    } else {
      await hydrate(newId)
    }
  } catch (e) {
    ElMessage.error(`启动失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    starting.value = false
  }
}

// ===== 技能管理 =====
const skills = ref<Skill[]>([])

async function loadSkills(): Promise<void> {
  try {
    if (!window.api.skills) {
      console.error('[loadSkills] window.api.skills is undefined')
      return
    }
    skills.value = await window.api.skills.list()
  } catch (e) {
    console.error('[loadSkills] failed:', e)
    ElMessage.error(`加载技能失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

async function toggleSkill(s: Skill, enabled: boolean): Promise<void> {
  try {
    await window.api.skills.toggle(s.id, enabled)
    s.enabled = enabled
  } catch (e) {
    ElMessage.error(`切换失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

const editingSkill = ref<Skill | null>(null)
const skillSaving = ref(false)
const skillDialog = reactive({ visible: false, name: '', description: '', promptTemplate: '' })

function openSkillDialog(s?: Skill): void {
  editingSkill.value = s || null
  skillDialog.visible = true
  skillDialog.name = s?.name || ''
  skillDialog.description = s?.description || ''
  skillDialog.promptTemplate = s?.promptTemplate || ''
}

async function saveSkill(): Promise<void> {
  if (!skillDialog.name.trim()) { ElMessage.warning('请填写技能名称'); return }
  if (!skillDialog.description.trim()) { ElMessage.warning('请填写能力说明'); return }
  if (!skillDialog.promptTemplate.trim()) { ElMessage.warning('请填写提示词模板'); return }
  skillSaving.value = true
  try {
    if (editingSkill.value) {
      await window.api.skills.update(editingSkill.value.id, {
        name: skillDialog.name.trim(),
        description: skillDialog.description.trim(),
        promptTemplate: skillDialog.promptTemplate.trim()
      })
    } else {
      await window.api.skills.create({
        name: skillDialog.name.trim(),
        description: skillDialog.description.trim(),
        promptTemplate: skillDialog.promptTemplate.trim()
      })
    }
    skillDialog.visible = false
    ElMessage.success('技能已保存')
    await loadSkills()
  } catch (e) {
    ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    skillSaving.value = false
  }
}

async function removeSkill(s: Skill): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除技能「${s.name}」吗？`, '删除技能', {
      type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消'
    })
  } catch { return }
  await window.api.skills.remove(s.id)
  await loadSkills()
  ElMessage.success('已删除')
}

// ===== 导演对话 =====
const messages = ref<ConversationMessage[]>([])
const inputText = ref('')
const sending = ref(false)
const chatBoxRef = ref<HTMLElement | null>(null)
const expandedTools = reactive(new Set<string>())

/** 根据当前项目状态动态推荐快捷指令 */
const quickPrompts = computed<string[]>(() => {
  const s = state.value
  const prompts: string[] = []
  if (s?.running) {
    prompts.push('现在进度怎么样？')
    if (s.failedShotIds.length > 0) prompts.push(`重渲失败的 ${s.failedShotIds.length} 个镜头`)
    else prompts.push('分镜都完成了吗？')
    if (s.paused) prompts.push('当前任务暂停了，帮我继续')
    else prompts.push('先暂停一下任务')
  } else if (s && !s.running) {
    if (s.cancelled) prompts.push('上次任务取消了，重新开拍一部霸总题材短片')
    else if (s.finalPath) prompts.push('成片做完了吗？给我总结一下这个项目')
    else prompts.push('继续跑未完成的流水线')
  } else {
    prompts.push('帮我开拍一部霸总题材短片', '现在有什么模板可以拍？')
  }
  prompts.push('检查一下 ComfyUI 状态')
  prompts.push('看看我存了哪些记忆')
  return prompts.slice(0, 4)
})

async function loadChat(): Promise<void> {
  messages.value = await window.api.conversation.list(chatScope.value)
  await scrollChatToBottom()
}

function toggleTool(id: string): void {
  if (expandedTools.has(id)) expandedTools.delete(id)
  else expandedTools.add(id)
}

function useQuick(q: string): void {
  inputText.value = q
  void sendMessage()
}

/** 极简 Markdown 渲染：加粗、行内代码、代码块、无序/有序列表、换行（白名单，无 XSS 风险） */
function renderMd(text: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const inline = (s: string): string => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // 代码块
    if (line.startsWith('```')) {
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++])
      out.push(`<pre class="md-code">${esc(buf.join('\n'))}</pre>`)
      i++
      continue
    }
    // 无序列表
    if (/^[-*•] /.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*•] /.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^[-*•] /, ''))}</li>`)
        i++
      }
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    // 有序列表
    if (/^\d+\. /.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\d+\. /, ''))}</li>`)
        i++
      }
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }
    // 空行 → 间距
    if (line.trim() === '') {
      out.push('<div class="md-spacer"></div>')
      i++
      continue
    }
    out.push(`<p>${inline(line)}</p>`)
    i++
  }
  return out.join('')
}

async function copyMsg(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  ElMessage.success('已复制')
}

function resendMsg(m: ConversationMessage): void {
  inputText.value = m.content
  void sendMessage()
}

/** 工具实时事件：权威列表返回前可能先到达，找不到消息就合成一条，send 返回后以全量列表为准 */
function applyToolEvent(e: ConversationToolEvent): void {
  if (e.scope !== chatScope.value) return
  const msg = messages.value.find(m => m.id === e.messageId)
  if (msg) {
    if (!msg.toolCalls) msg.toolCalls = []
    const idx = msg.toolCalls.findIndex(c => c.id === e.toolCall.id)
    if (idx >= 0) msg.toolCalls[idx] = e.toolCall
    else msg.toolCalls.push(e.toolCall)
  } else {
    messages.value.push({
      id: e.messageId,
      role: 'assistant',
      content: '',
      ts: Date.now(),
      toolCalls: [e.toolCall]
    })
  }
  void scrollChatToBottom()
}

async function sendMessage(): Promise<void> {
  const text = inputText.value.trim()
  if (!text || sending.value) return
  inputText.value = ''
  messages.value.push({ id: `local_${Date.now()}`, role: 'user', content: text, ts: Date.now() })
  sending.value = true
  await scrollChatToBottom()
  try {
    messages.value = await window.api.conversation.send(chatScope.value, text)
  } catch (e) {
    messages.value.push({
      id: `err_${Date.now()}`, role: 'assistant',
      content: `对话服务出错：${e instanceof Error ? e.message : String(e)}`,
      ts: Date.now(), error: true
    })
  } finally {
    sending.value = false
    await scrollChatToBottom()
  }
}

async function clearChat(): Promise<void> {
  if (!messages.value.length) return
  try {
    await ElMessageBox.confirm('确定清空与导演的对话记录吗？此操作不可恢复。', '清空对话', {
      type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消'
    })
  } catch { return }
  await window.api.conversation.clear(chatScope.value)
  messages.value = []
  expandedTools.clear()
}

async function scrollChatToBottom(): Promise<void> {
  await nextTick()
  const box = chatBoxRef.value
  if (box) box.scrollTop = box.scrollHeight
}

// ===== 记忆库 =====
const memoryKindOptions = [
  { value: 'preference', label: '用户偏好' },
  { value: 'rule', label: '制作规则' },
  { value: 'lesson', label: '经验教训' }
] as const
const memoryKind = ref<MemoryKind>('preference')
const memories = ref<MemoryItem[]>([])
const editingMemory = ref<MemoryItem | null>(null)
const memorySaving = ref(false)
const memoryDialog = reactive({
  visible: false,
  kind: 'preference' as MemoryKind,
  title: '',
  content: ''
})

const filteredMemories = computed(() => memories.value.filter(m => m.kind === memoryKind.value))
function memoryCountOf(kind: MemoryKind): number {
  return memories.value.filter(m => m.kind === kind).length
}
function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function loadMemories(): Promise<void> {
  memories.value = await window.api.memory.list()
}

function openMemoryDialog(m?: MemoryItem): void {
  editingMemory.value = m || null
  memoryDialog.visible = true
  memoryDialog.kind = m?.kind || memoryKind.value
  memoryDialog.title = m?.title || ''
  memoryDialog.content = m?.content || ''
}

async function saveMemory(): Promise<void> {
  if (!memoryDialog.title.trim()) { ElMessage.warning('请填写标题'); return }
  if (!memoryDialog.content.trim()) { ElMessage.warning('请填写内容'); return }
  memorySaving.value = true
  try {
    if (editingMemory.value) {
      await window.api.memory.update(editingMemory.value.id, {
        kind: memoryDialog.kind,
        title: memoryDialog.title.trim(),
        content: memoryDialog.content.trim()
      })
    } else {
      await window.api.memory.create({
        kind: memoryDialog.kind,
        title: memoryDialog.title.trim(),
        content: memoryDialog.content.trim()
      })
    }
    memoryDialog.visible = false
    ElMessage.success('记忆已保存')
    await loadMemories()
  } catch (e) {
    ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    memorySaving.value = false
  }
}

async function removeMemory(m: MemoryItem): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除记忆「${m.title}」吗？`, '删除记忆', {
      type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消'
    })
  } catch { return }
  await window.api.memory.remove(m.id)
  await loadMemories()
  ElMessage.success('已删除')
}

// ===== ComfyUI 控制面板 =====
const comfyStats = ref<ComfySystemStats | null>(null)
const nodeNames = ref<string[]>([])
const nodeQuery = ref('')
const comfyLoading = ref(false)
const comfyLoaded = ref(false)
const workflows = ref<WorkflowMeta[]>([])
const workflowParams = reactive<Record<string, WorkflowParam[]>>({})
const expandedWorkflows = ref<string[]>([])

const matchedNodes = computed(() => {
  const q = nodeQuery.value.trim().toLowerCase()
  if (!q) return []
  return nodeNames.value.filter(n => n.toLowerCase().includes(q))
})

// 工作流环境自检
const validateReports = ref<WorkflowCheckReport[]>([])
const validateLoading = ref(false)
const validateRun = ref(false)
const validateBadCount = computed(() =>
  validateReports.value.reduce((n, r) => n + r.issues.length, 0)
)

async function runValidate(): Promise<void> {
  validateLoading.value = true
  try {
    validateReports.value = await window.api.comfyui.validateWorkflows()
    validateRun.value = true
  } catch (e) {
    ElMessage.error(`自检失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    validateLoading.value = false
  }
}

function gb(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1)
}
/** ComfyUI 0.3x 的 devices[].name 形如 "cuda:0 NVIDIA GeForce RTX x : cudaMallocAsync"，清洗成型号 */
function gpuLabel(d: ComfyGpuDevice): string {
  const cleaned = (d.name || '')
    .replace(/^cuda:\d+\s*/i, '')
    .replace(/\s*:\s*cudaMalloc\w*\s*$/i, '')
    .trim()
  return cleaned || d.type || d.name
}
function vramPercent(d: ComfyGpuDevice): number {
  if (!d.vramTotal) return 0
  return Math.min(100, Math.round(((d.vramTotal - d.vramFree) / d.vramTotal) * 100))
}
function canEditParam(p: WorkflowParam): boolean {
  return !p.isPlaceholder && !p.isConnection
}

async function refreshComfy(): Promise<void> {
  comfyLoading.value = true
  try {
    const [stats, nodes] = await Promise.all([
      window.api.comfyui.getSystemStats(),
      window.api.comfyui.getObjectNodeNames()
    ])
    comfyStats.value = stats
    nodeNames.value = nodes
    comfyLoaded.value = true
  } finally {
    comfyLoading.value = false
  }
}

async function loadWorkflows(): Promise<void> {
  workflows.value = await window.api.workflow.list()
}

async function onWfExpand(active: string | string[]): Promise<void> {
  const arr = Array.isArray(active) ? active : [active]
  for (const name of arr) {
    if (!workflowParams[name]) {
      workflowParams[name] = await window.api.workflow.getParams(name)
    }
  }
}

async function updateWfParam(name: string, p: WorkflowParam, value: string | number | boolean): Promise<void> {
  try {
    await window.api.workflow.updateParam(name, p.nodeId, p.key, value)
    p.value = value
    ElMessage.success('参数已保存到工作流模板')
  } catch (e) {
    ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

// 首次切到 ComfyUI 面板时懒加载（object_info 体量大，避免启动时拖慢）
watch(activeModule, async (m) => {
  if (m === 'comfyui' && !comfyLoaded.value) {
    await Promise.all([refreshComfy(), loadWorkflows()])
  }
})
</script>

<style scoped>
.console {
  display: flex;
  gap: 16px;
  height: calc(100vh - 80px);
}
.console-aside {
  width: 230px;
  flex-shrink: 0;
  background: var(--bg-card);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  padding: 12px 0;
}
.aside-title {
  padding: 4px 16px 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}
.aside-menu {
  border-right: none;
  --el-menu-bg-color: transparent;
  --el-menu-text-color: var(--text-secondary);
  --el-menu-active-color: #67c23a;
  --el-menu-hover-bg-color: var(--bg-input);
}
.aside-menu :deep(.el-menu-item) { height: 44px; }
.aside-menu :deep(.el-menu-item.is-active) { background: #1a2a1a; }
.soon-tag { margin-left: auto; }
.aside-project {
  margin-top: auto;
  border-top: 1px solid var(--border-weak);
  padding: 12px 16px;
  font-size: 12px;
}
.aside-subtitle {
  color: var(--text-muted);
  font-size: 12px;
  margin-bottom: 8px;
}
.kv { display: flex; justify-content: space-between; margin-bottom: 6px; color: var(--text-secondary); }
.kv .v { color: var(--text-primary); display: flex; align-items: center; gap: 6px; }
.review-issues { margin-top: 10px; }
.issue-item {
  color: #f56c6c;
  font-size: 12px;
  line-height: 1.5;
  margin-bottom: 4px;
}
.final-path { margin-top: 10px; }

.console-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
}
.control-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-card);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  padding: 12px 16px;
}
.control-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 10px;
}
.pause-alert { border-radius: 8px; }

.panel {
  background: var(--bg-card);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  padding: 14px 16px;
}
.panel-grow {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.panel-fill {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}
.panel-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
  display: flex;
  align-items: center;
}
.log-title { justify-content: space-between; }
.log-hint { font-size: 12px; font-weight: 400; color: var(--text-muted); }

.stage-list { display: flex; flex-direction: column; gap: 2px; }
.stage-row {
  display: flex;
  gap: 12px;
  padding: 8px 4px;
  border-radius: 6px;
}
.stage-icon { width: 22px; display: flex; justify-content: center; color: var(--text-muted); font-size: 18px; }
.stage-row.is-running .stage-icon { color: #409eff; }
.stage-row.is-done .stage-icon { color: #67c23a; }
.stage-row.is-error .stage-icon { color: #f56c6c; }
.stage-row.is-skipped .stage-icon { color: var(--text-muted); }
.is-loading { animation: spin 1.4s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.stage-body { flex: 1; min-width: 0; }
.stage-head { display: flex; align-items: center; gap: 8px; }
.stage-name {
  font-size: 13px;
  color: var(--text-secondary);
}
.stage-row.is-running .stage-name,
.stage-row.is-done .stage-name,
.stage-row.is-error .stage-name { color: var(--text-primary); font-weight: 500; }
.gate-tag { transform: scale(0.9); }
.stage-msg {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stage-row.is-error .stage-msg { color: #f56c6c; }
.stage-progress { margin-top: 4px; max-width: 320px; }

.log-box {
  flex: 1;
  overflow-y: auto;
  min-height: 120px;
}
.log-collapse {
  --el-collapse-border-color: var(--border-weak);
  --el-collapse-header-bg-color: transparent;
  --el-collapse-content-bg-color: transparent;
  --el-collapse-header-text-color: var(--text-primary);
  --el-collapse-text-color: var(--text-primary);
}
.log-group-title { font-size: 13px; font-weight: 500; }
.log-count { margin-left: 10px; }
.log-entry {
  display: flex;
  gap: 10px;
  font-size: 12px;
  line-height: 1.9;
  padding: 0 8px;
  border-bottom: 1px dashed var(--border-weak);
}
.log-time { color: var(--text-muted); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.log-level { flex-shrink: 0; width: 34px; font-weight: 600; }
.lv-info { color: #409eff; }
.lv-success { color: #67c23a; }
.lv-warn { color: #e6a23c; }
.lv-error { color: #f56c6c; }
.log-msg { color: var(--text-secondary); }

/* ===== 技能管理 ===== */
.skills-title { justify-content: space-between; }
.skills-tip {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.7;
  margin: 0 0 14px;
}
.skills-tip code, .skill-dialog-hint code {
  background: var(--bg-input);
  border-radius: 3px;
  padding: 0 5px;
  color: #67c23a;
  font-size: 12px;
}
.skill-list { display: flex; flex-direction: column; gap: 10px; }
.skill-item {
  display: flex;
  align-items: center;
  gap: 14px;
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  padding: 12px 14px;
  background: var(--bg-app, transparent);
}
.skill-main { flex: 1; min-width: 0; }
.skill-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.skill-name { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.skill-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.skill-ops { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.skill-dialog-hint {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
  padding-left: 84px;
}

/* ===== 右栏对话 ===== */
.console-right {
  width: 360px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}
.chat-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 12px 14px;
}
.chat-title { justify-content: space-between; margin-bottom: 8px; }
.chat-title-text { display: flex; align-items: center; }
.chat-clear { color: var(--text-muted); }

.chat-box {
  flex: 1;
  overflow-y: auto;
  padding: 4px 2px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.chat-empty {
  margin: auto;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.8;
  padding: 0 16px;
}
.chat-empty-icon { font-size: 34px; margin-bottom: 10px; }
.chat-empty p { margin: 0 0 14px; }
.quick-chips { display: flex; flex-direction: column; gap: 8px; align-items: center; }
.quick-chip {
  cursor: pointer;
  padding: 6px 12px;
  height: auto;
  line-height: 1.5;
}

.msg-row { display: flex; }
.msg-row.is-user { justify-content: flex-end; }
.msg-row.is-assistant { justify-content: flex-start; }
.bubble {
  max-width: 88%;
  border-radius: 10px;
  padding: 9px 12px;
  font-size: 13px;
  line-height: 1.7;
  word-break: break-word;
}
.bubble-user {
  background: #67c23a;
  color: #fff;
  border-bottom-right-radius: 3px;
}
.bubble-assistant {
  background: var(--bg-input);
  border: 1px solid var(--border-weak);
  color: var(--text-primary);
  border-bottom-left-radius: 3px;
  width: 100%;
  max-width: 100%;
}
.msg-row.is-error .bubble-assistant { border-color: #f56c6c; color: #f56c6c; }
.msg-text { white-space: pre-wrap; }

/* 用户消息 wrapper */
.msg-user-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  max-width: 88%;
}
.msg-user-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px;
}

/* 消息底部操作栏 */
.msg-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
  justify-content: flex-end;
}
.msg-time {
  font-size: 11px;
  color: var(--text-muted);
}
.msg-op {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
  font-size: 13px;
}
.msg-row:hover .msg-op { opacity: 1; }
.msg-op:hover { color: var(--text-primary); background: var(--bg-input); }

/* Markdown 渲染 */
.msg-text p { margin: 0; line-height: 1.7; }
.msg-text .md-spacer { height: 6px; }
.msg-text ul, .msg-text ol { margin: 4px 0; padding-left: 20px; }
.msg-text li { margin: 2px 0; line-height: 1.7; }
.msg-text code {
  background: var(--bg-card);
  border: 1px solid var(--border-weak);
  border-radius: 3px;
  padding: 0 4px;
  font-size: 12px;
  font-family: monospace;
}
.msg-text .md-code {
  background: var(--bg-card);
  border: 1px solid var(--border-weak);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 6px 0;
  line-height: 1.6;
  max-height: 220px;
  overflow-y: auto;
}
.msg-text strong { font-weight: 600; }

.typing {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  width: auto;
}

/* 工具调用卡片 */
.tool-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.tool-card {
  border: 1px solid var(--border-weak);
  border-radius: 6px;
  background: var(--bg-card);
  overflow: hidden;
}
.tool-card.is-running { border-color: #409eff66; }
.tool-card.is-done { border-color: #67c23a55; }
.tool-card.is-error { border-color: #f56c6c66; }
.tool-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  cursor: pointer;
  font-size: 12px;
}
.tool-icon { font-size: 14px; flex-shrink: 0; }
.tc-done { color: #67c23a; }
.tc-error { color: #f56c6c; }
.tool-label { font-weight: 600; color: var(--text-primary); flex-shrink: 0; }
.tool-args {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.tool-caret { color: var(--text-muted); flex-shrink: 0; }
.tool-result {
  border-top: 1px dashed var(--border-weak);
  padding: 7px 10px;
  max-height: 180px;
  overflow: auto;
}
.tool-result pre {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  font-family: inherit;
}

.chat-input {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border-weak);
}
.chat-input .el-button { flex-shrink: 0; }

.confirm-tip { margin-bottom: 16px; }
.start-form :deep(.el-checkbox) { margin-right: 0; }
.gate-checks { display: flex; flex-direction: column; gap: 4px; }

/* ===== 记忆库 ===== */
.memory-tabs { margin-bottom: 6px; }
.memory-tabs :deep(.el-tabs__header) { margin-bottom: 10px; }
.memory-item { align-items: flex-start; }
.memory-content {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.memory-time { font-size: 11px; color: var(--text-muted); margin-top: 6px; }
.memory-item .skill-ops { margin-top: 2px; }

/* ===== ComfyUI 面板 ===== */
.comfy-panel { gap: 12px; }
.comfy-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.comfy-card {
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  padding: 12px 14px;
  background: var(--bg-app, transparent);
}
.comfy-panel > .comfy-card { margin-top: 0; }
.comfy-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
}
.comfy-card-body { display: flex; flex-direction: column; gap: 8px; }
.comfy-card-body .kv { margin-bottom: 0; font-size: 12px; }
.comfy-offline { display: flex; align-items: center; gap: 10px; }
.muted { color: var(--text-muted); font-size: 12px; }
.gpu-block + .gpu-block { margin-top: 12px; }
.gpu-name { font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }
.gpu-vram { font-size: 11px; color: var(--text-muted); margin-top: 5px; font-variant-numeric: tabular-nums; }
.node-search { margin-bottom: 10px; }
.node-matches { display: flex; flex-wrap: wrap; gap: 6px; max-height: 180px; overflow-y: auto; }
.node-tag { font-family: monospace; }
.validate-block { margin-bottom: 10px; padding: 8px 10px; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; background: rgba(255,255,255,0.03); }
.validate-wf { font-weight: 600; margin-bottom: 6px; font-family: monospace; }
.validate-issue { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 1.7; color: rgba(255,255,255,0.75); }

.wf-collapse {
  --el-collapse-border-color: var(--border-weak);
  --el-collapse-header-bg-color: transparent;
  --el-collapse-content-bg-color: transparent;
  --el-collapse-header-text-color: var(--text-primary);
}
.wf-name { font-size: 13px; font-weight: 500; margin-right: 8px; }
.wf-params { display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
.wf-param {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--bg-input);
}
.wf-param-label { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.wf-param-title { font-size: 12px; color: var(--text-primary); }
.wf-param-class { font-size: 11px; color: var(--text-muted); font-family: monospace; }
.wf-param-input { flex-shrink: 0; }
.wf-param-input .el-input-number { width: 150px; }
.wf-param-input .el-input { width: 200px; }
</style>
