import { app } from 'electron';
import { GameData } from '../../shared/gameData/GameData.js';
import { Character } from '../../shared/gameData/Character.js';
import { Config } from '../../shared/Config.js';
import { ApiConnection} from '../../shared/apiConnection.js';
import { checkActions } from './checkActions.js';
import { convertChatToText, buildChatPrompt, buildResummarizeChatPrompt, convertChatToTextNoNames} from './promptBuilder.js';
import { cleanMessageContent } from './messageCleaner.js';
import { summarize } from './summarize.js';
import fs from 'fs';
import path from 'path';

import {Message, MessageChunk, ErrorMessage, Summary, Action, ActionResponse} from '../ts/conversation_interfaces.js';
import { RunFileManager } from '../RunFileManager.js';
import { ChatWindow } from '../windows/ChatWindow.js';

const userDataPath = path.join(app.getPath('userData'), 'votc_data');

export class Conversation{
    chatWindow: ChatWindow;
    isOpen: boolean;
    gameData: GameData;
    messages: Message[];
    config: Config;
    runFileManager: RunFileManager;
    textGenApiConnection: ApiConnection;
    summarizationApiConnection: ApiConnection;
    actionsApiConnection: ApiConnection;
    description: string;
    actions: Action[];
    exampleMessages: Message[];
    summaries: Summary[];
    currentSummary: string;
    
    constructor(gameData: GameData, config: Config, chatWindow: ChatWindow){
        this.chatWindow = chatWindow;
        this.isOpen = true;
        this.gameData = gameData;
        this.messages = [];
        this.currentSummary = "";

        this.summaries = [];
        if (!fs.existsSync(path.join(userDataPath, 'conversation_summaries'))){
            fs.mkdirSync(path.join(userDataPath, 'conversation_summaries'));
        }

        if (!fs.existsSync(path.join(userDataPath, 'conversation_summaries', this.gameData.playerID.toString()))){
            fs.mkdirSync(path.join(userDataPath, 'conversation_summaries', this.gameData.playerID.toString()));
        }
        
        if(fs.existsSync(path.join(userDataPath, 'conversation_summaries', this.gameData.playerID.toString(), this.gameData.aiID.toString()+".json"))){
            this.summaries = JSON.parse(fs.readFileSync(path.join(userDataPath, 'conversation_summaries', this.gameData.playerID.toString(), this.gameData.aiID.toString()+".json"), 'utf8'));
        }
        else{
            this.summaries = [];
            fs.writeFileSync(path.join(userDataPath, 'conversation_summaries', this.gameData.playerID.toString(), this.gameData.aiID.toString()+".json"), JSON.stringify(this.summaries, null, '\t'));
        }

        this.config = config;

        //TODO: wtf
        this.runFileManager = new RunFileManager(config.userFolderPath);
        this.description = "";
        this.actions = [];
        this.exampleMessages = [],

        [this.textGenApiConnection, this.summarizationApiConnection, this.actionsApiConnection] = this.getApiConnections();
        
        this.loadConfig();
    }

    pushMessage(message: Message): void{           
        this.messages.push(message);
    }

    async generateAIsMessages() {
        const shuffled_characters = Array.from(this.gameData.characters.values()).sort(() => Math.random() - 0.5);
        for (const character of shuffled_characters) {
            if (character.id !== this.gameData.playerID) {
                await this.generateNewAIMessage(character);
            }
        }
        this.chatWindow.window.webContents.send('actions-receive', []);
    }
    
    async generateNewAIMessage(character: Character){

        
        let responseMessage: Message;

        if(this.config.stream){
            this.chatWindow.window.webContents.send('stream-start');
        }

        let currentTokens = this.textGenApiConnection.calculateTokensFromChat(buildChatPrompt(this, character));
        //let currentTokens = 500;
        console.log(`current tokens: ${currentTokens}`);

        if(currentTokens > this.textGenApiConnection.context){
            console.log(`Context limit hit, resummarizing conversation! limit:${this.textGenApiConnection.context}`);
            await this.resummarize();
        }

        let streamMessage = {
            role: "assistant",
            name: character.fullName,//this.gameData.aiName,
            content: ""
        }
        let cw = this.chatWindow;
        function streamRelay(msgChunk: MessageChunk): void{
            streamMessage.content += msgChunk.content;
            cw.window.webContents.send('stream-message', streamMessage)
        }


        if(this.textGenApiConnection.isChat()){
            
            responseMessage = {
                role: "assistant",
                name: character.fullName,//this.gameData.aiName,
                content: await this.textGenApiConnection.complete(buildChatPrompt(this, character), this.config.stream, {
                    //stop: [this.gameData.playerName+":", this.gameData.aiName+":", "you:", "user:"],
                    max_tokens: this.config.maxTokens,
                },
                streamRelay)
            };  
            
        }
        //instruct
        else{

            responseMessage = {
                role: "assistant",
                name: character.fullName,
                content: await this.textGenApiConnection.complete(convertChatToText(buildChatPrompt(this, character), this.config, character.fullName), this.config.stream, {
                    stop: [this.config.inputSequence, this.config.outputSequence],
                    max_tokens: this.config.maxTokens,
                },
                streamRelay)
            };
    
        }

        if(this.config.cleanMessages){
            responseMessage.content = cleanMessageContent(responseMessage.content);
        }

        this.pushMessage(responseMessage);

        if(!this.config.stream){
            this.chatWindow.window.webContents.send('message-receive', responseMessage, this.config.actionsEnableAll);
        }
        
        if (character.id === this.gameData.aiID){
            let collectedActions: ActionResponse[];
            if(this.config.actionsEnableAll){
                try{
                    collectedActions = await checkActions(this);
                }
                catch(e){
                    collectedActions = [];
                }
            }
            else{
                collectedActions = [];
            }
    
            this.chatWindow.window.webContents.send('actions-receive', collectedActions);    
        }
    }

    async resummarize(){
        let tokensToSummarize = this.textGenApiConnection.context * (this.config.percentOfContextToSummarize / 100)
        console.log(`context: ${this.textGenApiConnection.context} percent to summarize: ${this.config.percentOfContextToSummarize} tokens to summarize: ${tokensToSummarize}`)
            let tokenSum = 0;
            let messagesToSummarize: Message[] = [];

            while(tokenSum < tokensToSummarize && this.messages.length > 0){
                let msg = this.messages.shift()!;
                tokenSum += this.textGenApiConnection.calculateTokensFromMessage(msg);
                console.log("to remove:")
                console.log(msg)
                messagesToSummarize.push(msg);
            }

            if(messagesToSummarize.length > 0){ //prevent infinite loops
                console.log("current summary: "+this.currentSummary)
                if(this.summarizationApiConnection.isChat()){
                    this.currentSummary = await this.summarizationApiConnection.complete(buildResummarizeChatPrompt(this, messagesToSummarize), false, {});
                }
                else{
                    this.currentSummary = await this.summarizationApiConnection.complete(convertChatToTextNoNames(buildResummarizeChatPrompt(this, messagesToSummarize), this.config), false, {});
                }
               
                console.log("after current summary: "+this.currentSummary)
            }
    }

    //修改增加多人对话中每个参与对话角色的总结存储。add the summary storage for each participant in multi-character conversation.
    async summarize() {
        this.isOpen = false;
        // 向游戏写入触发事件（示例：触发对话结束事件）
        this.runFileManager.write("trigger_event = talk_event.9002");
        setTimeout(() => {
            this.runFileManager.clear();  // 延迟清理事件文件（确保游戏读取）
        }, 500);

        // 消息不足时不生成摘要
        if (this.messages.length < 6) {
            console.log("消息数量不足，不生成摘要");
            return;
        }

        // 生成新摘要（调用摘要工具函数）
        const summary: Summary = {
            date: this.gameData.date,  // 当前游戏内日期
            content: await summarize(this)  // 异步生成摘要内容
        };

        this.gameData.characters.forEach((_value, key) => {
            if (key !== this.gameData.playerID) {
                this.summaries=[]
                const summaryDir = path.join(userDataPath, 'conversation_summaries', this.gameData.playerID.toString());
                if (!fs.existsSync(summaryDir)) {
                    fs.mkdirSync(summaryDir, { recursive: true });
                }
        
                // 加载历史摘要（若存在）
                const summaryFile = path.join(summaryDir, `${key.toString()}.json`);
                if (fs.existsSync(summaryFile)) {
                    this.summaries = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
                } else {
                    fs.writeFileSync(summaryFile, JSON.stringify(this.summaries, null, '\t'));  // 初始化空摘要文件
                }
                        // 添加到历史摘要列表（插入到最前面）
                this.summaries.unshift(summary);
        // 持久化存储摘要（按玩家ID和AI ID分类）
                const summaryFile1 = path.join(
                    userDataPath, 
                    'conversation_summaries', 
                    this.gameData.playerID.toString(), 
                    `${key.toString()}.json`
                    );
                fs.writeFileSync(summaryFile1, JSON.stringify(this.summaries, null, '\t'));
            }
            })
        }; 

    updateConfig(config: Config){
        console.log("config updated!")
        this.loadConfig();
    }

    loadConfig(){

        console.log(this.config.toSafeConfig());

        this.runFileManager = new RunFileManager(this.config.userFolderPath);
        this.runFileManager.clear();

        this.description = "";
        this.exampleMessages = [];

        const descriptionPath = path.join(userDataPath, 'scripts', 'prompts', 'description', this.config.selectedDescScript)
        try{
            delete require.cache[require.resolve(path.join(descriptionPath))];
            this.description = require(path.join(descriptionPath))(this.gameData); 
        }catch(err){
            throw new Error("description script error, your used description script file is not valid! error message:\n"+err);
        }
        const exampleMessagesPath = path.join(userDataPath, 'scripts', 'prompts', 'example messages', this.config.selectedExMsgScript);
        try{
            delete require.cache[require.resolve(path.join(exampleMessagesPath))];
            this.exampleMessages= require(path.join(exampleMessagesPath))(this.gameData);
        }catch(err){
            throw new Error("example messages script error, your used example messages file is not valid! error message:\n"+err);
        }
    
        this.loadActions();
    }

    getApiConnections(){
        let textGenApiConnection, summarizationApiConnection, actionsApiConnection
        summarizationApiConnection = textGenApiConnection = actionsApiConnection = new ApiConnection(this.config.textGenerationApiConnectionConfig.connection, this.config.textGenerationApiConnectionConfig.parameters);

        if(this.config.summarizationUseTextGenApi){
            this.summarizationApiConnection = new ApiConnection(this.config.textGenerationApiConnectionConfig.connection, this.config.summarizationApiConnectionConfig.parameters);;
        }

        if(this.config.actionsUseTextGenApi){;
            this.actionsApiConnection = new ApiConnection(this.config.textGenerationApiConnectionConfig.connection, this.config.actionsApiConnectionConfig.parameters);;
        }
        return [textGenApiConnection, summarizationApiConnection, actionsApiConnection];
    }

    async loadActions(){
        this.actions = [];

        const actionsPath = path.join(userDataPath, 'scripts', 'actions');
        let standardActionFiles = fs.readdirSync(path.join(actionsPath, 'standard')).filter(file => path.extname(file) === ".js");
        let customActionFiles = fs.readdirSync(path.join(actionsPath, 'custom')).filter(file => path.extname(file) === ".js");

        for(const file of standardActionFiles) {

            if(this.config.disabledActions.includes(path.basename(file).split(".")[0])){
                continue;
            }
            
            delete require.cache[require(path.join(actionsPath, 'standard', file))];
            this.actions.push(require(path.join(actionsPath, 'standard', file)));
            console.log(`loaded standard action: `+file)
        }

        for(const file of customActionFiles) {

            if(this.config.disabledActions.includes(path.basename(file).split(".")[0])){
                continue;
            }
    
            delete require.cache[require(path.join(actionsPath, 'custom', file))];
            this.actions.push(require(path.join(actionsPath, 'custom', file)));
            console.log(`loaded custom action: `+file)
        }
    }

}

