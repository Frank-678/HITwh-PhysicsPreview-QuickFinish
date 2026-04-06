// ==UserScript==
// @name         物理实验系统自动答题 Agent (DeepSeek 专属单体版)
// @namespace    http://tampermonkey.net/
// @version      3.0.DS
// @description  专门针对 DeepSeek 接口标准优化的批处理自动化架构
// @author       Frank
// @match        *://openlab.hitwh.edu.cn/dxwl/*
// @grant        GM_xmlhttpRequest
// @connect      api.deepseek.com
// ==/UserScript==

(function() {
    'use strict';

    // 核心物理配置：剥离所有冗余提供商，仅保留 DeepSeek 环境常量
    const CONFIG = {
        API_KEYS: [
            ""  // 必须真金白银。
        ],
        MODEL: "deepseek-chat", // 严谨约束为 DeepSeek 标准对话模型
        URL: "https://api.deepseek.com/chat/completions",
        DELAY_MS: 3000
    };

    let currentKeyIndex = 0;

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function isVisible(elem) {
        return !!(elem && elem.offsetWidth > 0 && elem.offsetHeight > 0 && elem.offsetParent !== null);
    }

    // 决策模块：硬编码适配 DeepSeek (OpenAI 协议) 规范
    function getBatchDecisionFromAPI(expName, paperText, questionCount) {
        return new Promise((resolve, reject) => {
            const prompt = `你是一个严谨的物理学专家。当前正在解答的大学物理实验预考核项目是：【${expName}】。
请结合该实验的物理原理连贯作答。
要求条件：
1. 大学物理题需要严谨的推导。请针对每一道题，简要写出你的物理公式与思考计算过程。
2. 所有的推理完成后，必须在回复的最末尾，使用 \`\`\`json 和 \`\`\` 包裹输出最终的纯答案数组。
3. 数组元素为正确选项的大写字母。数组长度必须严格等于题目数量（本卷共 ${questionCount} 题）。
输出示例：
(你的物理推导过程...)
\`\`\`json
["A", "B", "C", "D"]
\`\`\`

试卷内容如下：
${paperText}`;

            const activeKey = CONFIG.API_KEYS[currentKeyIndex];

            GM_xmlhttpRequest({
                method: "POST",
                url: CONFIG.URL,
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${activeKey}` // 严格遵循 Bearer 鉴权标准
                },
                timeout: 45000, // 设定 45 秒超时，容纳大模型长文本的 Time To Last Byte
                data: JSON.stringify({
                    model: CONFIG.MODEL,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.1 // 极低温度，压制模型幻觉，确保输出格式具备确定性
                }),
                onload: function(response) {
                    try {
                        if (response.status === 429) {
                            reject("KEY_EXHAUSTED");
                            return;
                        }
                        if (response.status === 402) {
                            console.error("[物理阻断] HTTP 402: 账户余额耗尽，计费网关拒绝服务。");
                            reject("INSUFFICIENT_BALANCE");
                            return;
                        }
                        if (response.status !== 200) {
                            console.error(`[API 状态异常] HTTP ${response.status}: ${response.responseText}`);
                            reject("API_ERROR");
                            return;
                        }

                        const resJson = JSON.parse(response.responseText);
                        const rawText = resJson.choices[0].message.content.trim();

                        console.log("DeepSeek 原始推导回传截取：", rawText.substring(0, 150) + "...");

                        // 正则提取清洗：从思维链推导长文中剥离最终的 JSON 数组
                        const jsonMatch = rawText.match(/```json\s*(\[[^\]]+\])\s*```/i) || rawText.match(/(\[[^\]]+\])/);

                        if (!jsonMatch) {
                            console.error("正则提取失败，未能匹配到数组结构。");
                            reject("PARSE_ERROR");
                            return;
                        }

                        const answerArray = JSON.parse(jsonMatch[1]);
                        if (Array.isArray(answerArray) && answerArray.length === questionCount) {
                            resolve(answerArray);
                        } else {
                            console.error(`数组长度异常: 期望 ${questionCount}，实际返回 ${answerArray.length}`);
                            reject("LENGTH_MISMATCH");
                        }
                    } catch (e) {
                        console.error("响应报文反序列化或数据提取失败:", e);
                        reject("PARSE_ERROR");
                    }
                },
                onerror: function(err) {
                    console.error("底层网络物理层被截断或浏览器沙盒拦截:", err);
                    reject("NETWORK_ERROR");
                },
                ontimeout: function() { reject("TIMEOUT"); }
            });
        });
    }

    // 主调度状态机
    async function runAgent() {
        console.log(`Agent (DeepSeek 单体版) 启动，挂载并发秘钥数：${CONFIG.API_KEYS.length}`);

        while (true) {
            await sleep(CONFIG.DELAY_MS);

            const buttons = Array.from(document.querySelectorAll("button"));
            const submitBtn = buttons.find(b => b.innerText.includes("提交答案") && isVisible(b));
            const returnBtn = buttons.find(b => b.innerText.includes("返 回") && isVisible(b));

            // 状态一：预考核试卷装载状态
            if (submitBtn) {
                console.log("状态判定：【预考核答题页】，启动 DOM 树遍历与结构化重组...");
                const cards = document.querySelectorAll(".ant-card-bordered");
                const currentExpName = sessionStorage.getItem("LSM_EXP_NAME") || "未知物理实验";

                let paperText = "";
                let allTargetNodes = [];
                let validQuestionCount = 0;

                for (let card of cards) {
                    if (!card.innerText.includes("试题:")) continue;
                    validQuestionCount++;

                    const titleNode = card.querySelector("div[style='padding: 12px;'] > div:nth-child(2)");
                    const titleText = titleNode ? titleNode.innerText.trim() : "";

                    paperText += `\n第 ${validQuestionCount} 题：${titleText}\n`;

                    const radioBlocks = card.querySelectorAll(".exam-radio");
                    let currentQuestionNodes = [];

                    radioBlocks.forEach((block, index) => {
                        const letter = String.fromCharCode(65 + index);
                        const optTextNode = block.querySelector(".ant-col-22");
                        const optText = optTextNode ? optTextNode.innerText.trim() : "";
                        paperText += `${letter}. ${optText}\n`;

                        currentQuestionNodes.push(block.querySelector("input[type='radio']"));
                    });
                    allTargetNodes.push(currentQuestionNodes);
                }

                if (validQuestionCount > 0) {
                    console.log(`载入语境【${currentExpName}】。试卷共 ${validQuestionCount} 题。向 DeepSeek 发起批处理请求...`);

                    let paperSolved = false;
                    let exhaustedKeysCount = 0;
                    let maxRetries = 4;

                    while (!paperSolved && maxRetries > 0) {
                        await sleep(2500);

                        try {
                            const answerArray = await getBatchDecisionFromAPI(currentExpName, paperText, validQuestionCount);
                            console.log("DeepSeek 返回决策矩阵:", answerArray);

                            for (let i = 0; i < answerArray.length; i++) {
                                const ansLetter = answerArray[i];
                                const ansIndex = ansLetter.charCodeAt(0) - 65;
                                const nodes = allTargetNodes[i];

                                if (nodes && nodes[ansIndex]) {
                                    nodes[ansIndex].click();
                                }
                            }

                            paperSolved = true;
                            console.log("DOM 节点物理映射完毕，准备触发表单提交...");
                            await sleep(1500);

                        } catch (err) {
                            if (err === "KEY_EXHAUSTED") {
                                exhaustedKeysCount++;
                                currentKeyIndex = (currentKeyIndex + 1) % CONFIG.API_KEYS.length;
                                console.warn(`当前 API Key 触发 429 熔断，状态机自动轮询至索引 [${currentKeyIndex}]...`);

                                if (exhaustedKeysCount >= CONFIG.API_KEYS.length) {
                                    console.warn(`所有挂载的 DeepSeek Key 并发耗尽，系统挂起 60 秒执行退避策略...`);
                                    await sleep(60000);
                                    exhaustedKeysCount = 0;
                                }
                            } else if (err === "INSUFFICIENT_BALANCE") {
                                console.error("检测到 402 余额耗尽，物理终止当前试卷请求过程。");
                                break; // 强制跳出请求循环，提交空卷防止死锁
                            } else {
                                maxRetries--;
                                console.error(`批处理解析抛出硬性异常 (${err})。当前试卷剩余重试配额: ${maxRetries}`);
                                await sleep(3000);
                            }
                        }
                    }

                    if (!paperSolved) {
                        console.error("超出容错重试上限或资金耗尽，系统执行防御性空卷提交以打破阻塞。");
                    }
                }

                submitBtn.click();
                await sleep(CONFIG.DELAY_MS);
                continue;
            }

            // 状态二：考核成绩回传状态
            if (returnBtn && !submitBtn) {
                console.log("状态判定：【结果确认页】，回收页面并执行内存重载...");
                returnBtn.click();
                await sleep(CONFIG.DELAY_MS);
                location.reload();
                await sleep(CONFIG.DELAY_MS * 2);
                continue;
            }

            // 状态三：实验项目聚合列表状态
            const rows = document.querySelectorAll("tr.ant-table-row");
            let clicked = false;

            for (let row of rows) {
                const text = row.innerText;

                if (text.includes("下次准考时间")) {
                    continue;
                }

                if (text.includes("未通过") && text.includes("可考试") && isVisible(row)) {
                    const nameSpanNode = row.querySelector("span[style*='font-weight: bold']");
                    const expName = nameSpanNode ? nameSpanNode.innerText.trim() : text.split('\n')[0];
                    sessionStorage.setItem("LSM_EXP_NAME", expName);

                    console.log(`感知目标项目：【${expName}】，激活流转动作。`);
                    row.click();
                    clicked = true;
                    await sleep(CONFIG.DELAY_MS);
                    break;
                }
            }
        }
    }

    setTimeout(runAgent, 3000);
})();