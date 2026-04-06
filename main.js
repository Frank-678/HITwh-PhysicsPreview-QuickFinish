// ==UserScript==
// @name         物理实验系统自动答题 Agent
// @namespace    http://tampermonkey.net/
// @version      2.1.0
// @description  基于真实 DOM 结构的自动化考试执行脚本
// @author       Frank
// @match        http://openlab.hitwh.edu.cn/dxwl/*
// @grant        GM_xmlhttpRequest
// @connect      generativelanguage.googleapis.com
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

const CONFIG = {
        API_KEY: "",
        MODEL: "gemini-2.5-flash",
        DELAY_MS: 3000
    };

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    // 辅助函数：判断 DOM 元素在页面上是否真实可见
    function isVisible(elem) {
        return !!(elem && elem.offsetWidth > 0 && elem.offsetHeight > 0 && elem.offsetParent !== null);
    }


// 决策模块：调用大模型（附带底层现象探针与防并发限流机制）
    function getDecisionFromAPI(question, options) {
        return new Promise((resolve, reject) => {
            const prompt = `你是一个严谨的物理学专家。请回答下面的单选题。要求：只输出正确选项的大写字母（例如 A、B、C 或 D），绝对不要输出任何解析或标点符号。\n\n题目：${question}\n选项：\n${options}`;

            GM_xmlhttpRequest({
                method: "POST",
                url: `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL}:generateContent?key=${CONFIG.API_KEY}`,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                }),
                onload: function(response) {
                    try {
                        // 【现象探针】：严谨打印 HTTP 状态码与未经修饰的原始响应体
                        if (response.status !== 200) {
                            console.error(`[API 异常] HTTP 状态码: ${response.status}`);
                            console.error(`[API 响应报文]: ${response.responseText}`);
                            reject(`API 请求失败，状态码被拒绝`);
                            return;
                        }

                        const resJson = JSON.parse(response.responseText);

                        // 校验条件：检查字段是否存在，避免 TypeError 导致脚本崩溃
                        if (!resJson.candidates || resJson.candidates.length === 0) {
                            console.error(`[API 结构异常] 原始报文: ${response.responseText}`);
                            reject("API 返回了非预期的 JSON 结构（缺失 candidates）");
                            return;
                        }

                        const answer = resJson.candidates[0].content.parts[0].text.trim().toUpperCase();
                        const match = answer.match(/[A-D]/);
                        resolve(match ? match[0] : "A");
                    } catch (e) {
                        console.error("[解析层严重错误]:", e);
                        reject("大模型返回数据解析异常");
                    }
                },
                onerror: function(err) {
                    console.error("[底层网络错误]: 无法连接到目标服务器");
                    reject("网络请求底层的通信错误");
                }
            });
        });
    }

    // 主调度状态机
    async function runAgent() {
        console.log("Agent 2.0 已加载，监听系统 DOM 状态中...");

        while (true) {
            await sleep(CONFIG.DELAY_MS);

            // 探索页面中是否存在“提交答案”按钮，借此判定是否处于考试页面
            const buttons = Array.from(document.querySelectorAll("button"));
            const submitBtn = buttons.find(b => b.innerText.includes("提交答案") && isVisible(b));
            const returnBtn = buttons.find(b => b.innerText.includes("返 回") && isVisible(b));

            if (submitBtn) {
                console.log("状态判定：当前处于【预考核答题页】");
                const cards = document.querySelectorAll(".ant-card-bordered");

                for (let card of cards) {
                    // 仅处理真实的试题卡片
                    if (!card.innerText.includes("试题:")) continue;

                    // 1. 提取题干
                    const titleNode = card.querySelector("div[style='padding: 12px;'] > div:nth-child(2)");
                    const titleText = titleNode ? titleNode.innerText.trim() : "";

                    // 2. 提取选项
                    const radioBlocks = card.querySelectorAll(".exam-radio");
                    let optionsText = "";
                    let targetNodes = []; // 保存点击映射目标

                    radioBlocks.forEach((block, index) => {
                        const letter = String.fromCharCode(65 + index); // 转换为 A, B, C, D
                        const optTextNode = block.querySelector(".ant-col-22");
                        const optText = optTextNode ? optTextNode.innerText.trim() : "";
                        optionsText += `${letter}. ${optText}\n`;

                        // 记录需要点击的原生 input 节点
                        targetNodes.push(block.querySelector("input[type='radio']"));
                    });

                    if (titleText && optionsText) {
                        console.log(`正在请求大模型: ${titleText.substring(0, 15)}...`);
                        try {
                            // 强制延时 1.5 秒，避免瞬间发出十几个请求被 Google 阻断
                            //await sleep(1500);

                            const answerLetter = await getDecisionFromAPI(titleText, optionsText);
                            console.log(`模型决策完成: 选择 ${answerLetter}`);

                            // 3. 映射并执行点击
                            const ansIndex = answerLetter.charCodeAt(0) - 65;
                            if (ansIndex >= 0 && ansIndex < targetNodes.length) {
                                if (targetNodes[ansIndex]) {
                                    targetNodes[ansIndex].click();
                                    await sleep(500); // 严谨地预留界面 DOM 的重绘时间
                                }
                            }
                        } catch (err) {
                            console.error("单题执行中断:", err);
                            // 结论：在此处补充如下逻辑。当某道题触发报错时，强制整个脚本在此处挂起 60000 毫秒（1 分钟），等待服务端的配额池完全重置后，再去处理下一道题。
                            //await sleep(60000);
                        }
                    }
                }

                console.log("试卷作答完毕，执行提交指令");
                submitBtn.click();
                await sleep(CONFIG.DELAY_MS);
                continue;
            }

            // 如果处于过渡态且存在可见的返回按钮，执行返回并刷新
            if (returnBtn && !submitBtn) {
                console.log("状态判定：当前处于【提交后结果页】，执行返回并硬刷新网页");
                returnBtn.click();

                // 1. 等待返回按钮的点击事件与后端交互完成
                await sleep(CONFIG.DELAY_MS);

                // 2. 触发浏览器强制刷新，同步最新考试状态
                location.reload();

                // 3. 挂起当前状态机的循环，等待浏览器彻底重载环境
                await sleep(CONFIG.DELAY_MS * 2);
                continue;
            }

            // 若非答题页，则判定是否处于列表页
            console.log("状态判定：当前处于【实验项目列表页】");
            const rows = document.querySelectorAll("tr.ant-table-row");
            let clicked = false;

            for (let row of rows) {
                const text = row.innerText;
                // 必须同时满足文本条件且节点可见
                if (text.includes("未通过") && text.includes("可考试") && isVisible(row)) {
                    console.log(`感知到考核项目，触发点击事件。`);
                    row.click();
                    clicked = true;
                    await sleep(CONFIG.DELAY_MS);
                    break; // 每次只进入一个考核
                }
            }

            // 若当前无可考试项目，系统挂起等待
            if (!clicked && rows.length > 0 && isVisible(rows[0])) {
                console.log("当前列表无待考项目，轮询等待...");
            }
        }
    }

    // 延时挂载启动，确保前端框架渲染完毕
    setTimeout(runAgent, 3000);
})();