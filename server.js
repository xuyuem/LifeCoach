import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

// 加载环境变量
dotenv.config();

// 创建数据库连接池
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '123456',
    database: process.env.DB_NAME || 'life_coach',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// 初始化数据库表
async function initDatabase() {
    try {
        const connection = await pool.getConnection();
        await connection.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(255),
                message_type ENUM('user', 'assistant'),
                content TEXT,
                sentiment_score FLOAT,
                keywords TEXT,
                topic VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        connection.release();
        console.log('数据库初始化成功');
    } catch (error) {
        console.error('数据库初始化失败:', error);
    }
}

const app = express();
const port = 3000;

// 配置CORS和JSON解析
app.use(cors());
app.use(express.json());

// API配置
const API_KEY = process.env.API_KEY;
const API_URL = process.env.API_URL || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

// 处理聊天请求
app.post('/chat', async (req, res) => {
    try {
        const userMessage = req.body.message;
        const userId = req.body.userId || 'anonymous';

        // 存储用户消息
        await pool.query(
            'INSERT INTO messages (user_id, message_type, content) VALUES (?, ?, ?)',
            [userId, 'user', userMessage]
        );

        // 设置请求头
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`
        };

        // 准备请求体
        const requestBody = {
            model: 'deepseek-r1-250120',
            messages: [
                {
                    role: 'system',
                    content: '你是一位专业的Life Coach，擅长通过对话方式帮助人们进行个人成长。你会倾听用户的问题，给出有建设性的建议和指导。你的回答应该富有同理心，并且始终保持积极、鼓励的态度。'
                },
                {
                    role: 'user',
                    content: userMessage
                }
            ],
            stream: true,
            temperature: 0.6
        };

        // 发送请求到DeepSeek API
        const apiResponse = await fetch(API_URL, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody),
            timeout: 60000 // 60秒超时
        });

        if (!apiResponse.ok) {
            throw new Error(`API请求失败: ${apiResponse.status}`);
        }

        // 设置响应头
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');

        // 流式传输API响应
        let buffer = '';
        let fullResponse = '';
        for await (const chunk of apiResponse.body) {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const jsonStr = line.slice(6);
                    if (jsonStr.trim() === '[DONE]') continue;

                    try {
                        const json = JSON.parse(jsonStr);
                        if (json.choices && json.choices[0].delta && json.choices[0].delta.content) {
                            const content = json.choices[0].delta.content;
                            res.write(content);
                            fullResponse += content;
                        }
                    } catch (e) {
                        console.error('JSON解析错误:', e);
                    }
                }
            }
        }

        // 处理最后可能剩余的数据
        if (buffer.trim() && buffer.startsWith('data: ')) {
            const jsonStr = buffer.slice(6);
            if (jsonStr.trim() !== '[DONE]') {
                try {
                    const json = JSON.parse(jsonStr);
                    if (json.choices && json.choices[0].delta && json.choices[0].delta.content) {
                        const content = json.choices[0].delta.content;
                        res.write(content);
                        fullResponse += content;
                    }
                } catch (e) {
                    console.error('JSON解析错误:', e);
                }
            }
        }

        // 将AI助手的完整回复保存到数据库
        await pool.query(
            'INSERT INTO messages (user_id, message_type, content) VALUES (?, ?, ?)',
            [userId, 'assistant', fullResponse]
        );

        res.end();

    } catch (error) {
        console.error('服务器错误:', error);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// 启动服务器
app.listen(port, async () => {
    await initDatabase();
    console.log(`服务器运行在 http://localhost:${port}`);
});
// 获取情感分析数据
app.get('/analysis', async (req, res) => {
    try {
        // 获取情感趋势数据
        const [sentimentData] = await pool.query(
            `SELECT DATE(created_at) as date, AVG(sentiment_score) as score
            FROM messages
            WHERE message_type = 'user' AND sentiment_score IS NOT NULL
            GROUP BY DATE(created_at)
            ORDER BY date DESC
            LIMIT 7`
        );

        // 获取主题分布数据
        const [topicData] = await pool.query(
            `SELECT topic, COUNT(*) as count
            FROM messages
            WHERE message_type = 'user' AND topic IS NOT NULL
            GROUP BY topic
            ORDER BY count DESC
            LIMIT 5`
        );

        // 获取关键词数据
        const [keywordsData] = await pool.query(
            `SELECT keywords
            FROM messages
            WHERE message_type = 'user' AND keywords IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 100`
        );

        // 处理关键词数据
        const keywordMap = new Map();
        keywordsData.forEach(row => {
            const keywords = JSON.parse(row.keywords);
            keywords.forEach(keyword => {
                keywordMap.set(keyword, (keywordMap.get(keyword) || 0) + 1);
            });
        });

        const keywordsList = Array.from(keywordMap.entries())
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 50);

        res.json({
            sentiment: sentimentData,
            topics: topicData,
            keywords: keywordsList
        });

    } catch (error) {
        console.error('获取分析数据失败:', error);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// 获取历史对话记录
app.get('/history', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 10;
        const offset = (page - 1) * pageSize;

        // 获取用户消息和对应的AI回复
        const [rows] = await pool.query(
            `SELECT 
                m1.*,
                (
                    SELECT content
                    FROM messages m2
                    WHERE m2.user_id = m1.user_id
                    AND m2.message_type = 'assistant'
                    AND m2.created_at > m1.created_at
                    AND NOT EXISTS (
                        SELECT 1
                        FROM messages m3
                        WHERE m3.user_id = m1.user_id
                        AND m3.created_at > m1.created_at
                        AND m3.created_at < m2.created_at
                    )
                    LIMIT 1
                ) as ai_content,
                (
                    SELECT created_at
                    FROM messages m2
                    WHERE m2.user_id = m1.user_id
                    AND m2.message_type = 'assistant'
                    AND m2.created_at > m1.created_at
                    AND NOT EXISTS (
                        SELECT 1
                        FROM messages m3
                        WHERE m3.user_id = m1.user_id
                        AND m3.created_at > m1.created_at
                        AND m3.created_at < m2.created_at
                    )
                    LIMIT 1
                ) as ai_created_at
            FROM messages m1
            WHERE m1.message_type = 'user'
            ORDER BY m1.created_at DESC
            LIMIT ? OFFSET ?`,
            [pageSize, offset]
        );

        // 获取总记录数
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) as total
            FROM messages
            WHERE message_type = 'user'`
        );

        // 格式化对话数据
        const conversations = rows.map(row => ({
            user_message: {
                content: row.content,
                created_at: row.created_at
            },
            ai_message: {
                content: row.ai_content,
                created_at: row.ai_created_at
            }
        }));

        res.json({
            conversations,
            totalPages: Math.ceil(total / pageSize)
        });

    } catch (error) {
        console.error('获取历史记录失败:', error);
        res.status(500).json({ error: '服务器内部错误' });
    }
});