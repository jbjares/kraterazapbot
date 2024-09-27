const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs-extra');
const path = require('path');
const { google } = require('googleapis');
const ffmpeg = require('fluent-ffmpeg');
const qrcode = require('qrcode-terminal');
const dotenv = require('dotenv');
dotenv.config();

const localDirectories = {
    audio: process.env.LOCAL_AUDIO_DIR,
    image: process.env.LOCAL_IMAGE_DIR,
    video: process.env.LOCAL_VIDEO_DIR,
    text: process.env.LOCAL_TEXT_DIR,
    contacts: process.env.LOCAL_CONTACTS_DIR,
    stickers: process.env.LOCAL_STICKERS_DIR,
    other: process.env.LOCAL_OTHER_DIR
};

// Função para garantir que os diretórios existam
function ensureDirectoriesExist() {
    Object.values(localDirectories).forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

// Função para inicializar o cliente Google Drive
async function getDriveClient() {
    const credentials = require(process.env.GOOGLE_SERVICE_ACCOUNT_PATH);
    const auth = new google.auth.GoogleAuth({
        credentials: credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    return google.drive({ version: 'v3', auth });
}

// Função para criar diretório no Google Drive se não existir
async function createDriveFolderIfNotExists(driveClient, folderName, parentId = 'root') {
    const response = await driveClient.files.list({
        q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents`,
        fields: 'files(id, name)',
    });
    if (response.data.files.length > 0) {
        return response.data.files[0].id;
    } else {
        const folder = await driveClient.files.create({
            resource: {
                'name': folderName,
                'mimeType': 'application/vnd.google-apps.folder',
                'parents': [parentId],
            },
            fields: 'id',
        });
        return folder.data.id;
    }
}

// Função para fazer upload para o Google Drive mantendo a estrutura de pastas
async function uploadToDrive(filePath, fileName, mimeType, driveClient, folderStructure) {
    let parentId = 'root';
    for (const folder of folderStructure) {
        parentId = await createDriveFolderIfNotExists(driveClient, folder, parentId);
    }

    const fileMetadata = {
        'name': fileName,
        'parents': [parentId],
    };
    const media = {
        mimeType: mimeType,
        body: fs.createReadStream(filePath),
    };

    const response = await driveClient.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id',
    });

    if (response.data.id) {
        console.log(`Arquivo ${fileName} foi enviado ao Google Drive, ID: ${response.data.id}`);
        // Após confirmação de upload bem-sucedido, remover o arquivo local
        fs.removeSync(filePath);
        console.log(`Arquivo ${filePath} foi removido do diretório local.`);
        return true;
    } else {
        console.error(`Erro ao enviar ${fileName} para o Google Drive.`);
        return false;
    }
}

// Função para converter arquivos .opus para .mp3
async function convertOpusToMp3(sourcePath, targetPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(sourcePath)
            .toFormat('mp3')
            .on('end', () => {
                console.log(`Arquivo .opus convertido para .mp3 e salvo em ${targetPath}`);
                resolve();
            })
            .on('error', err => {
                console.error(`Erro ao converter ${sourcePath} para .mp3: ${err.message}`);
                reject(err);
            })
            .save(targetPath);
    });
}

// Configuração do cliente do WhatsApp Web
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true }
});

// Exibir QR code para login
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    console.log('Escaneie o código QR para autenticar no WhatsApp');
});

// Quando o cliente estiver pronto
client.on('ready', async () => {
    console.log('Cliente WhatsApp pronto!');

    // Garantir que os diretórios existem
    ensureDirectoriesExist();

    // Procurar o grupo "KRATERA"
    const chats = await client.getChats();
    const groupChat = chats.find(chat => chat.isGroup && chat.name === 'KRATERA');

    if (!groupChat) {
        console.error('Grupo KRATERA não encontrado.');
        return;
    }

    console.log(`Monitorando o grupo: ${groupChat.name}`);

    // Escutar mensagens do grupo KRATERA
    client.on('message', async message => {
        if (message.from === groupChat.id._serialized) {
            console.log(`Mensagem recebida no grupo ${groupChat.name}: ${message.body}`);

            if (message.hasMedia) {
                const media = await message.downloadMedia();
                const randomId = Math.floor(Math.random() * 1000000000);
                let fileName, filePath, folderStructure;

                if (media.mimetype.startsWith('audio/ogg') || media.mimetype === 'audio/opus') {
                    fileName = `audio_${randomId}.mp3`;
                    const opusFile = path.join(localDirectories.audio, `audio_${randomId}.opus`);
                    filePath = path.join(localDirectories.audio, fileName);

                    // Salvar o arquivo .opus
                    fs.writeFileSync(opusFile, media.data, 'base64');
                    console.log(`Áudio .opus salvo como ${opusFile}`);

                    // Converter para .mp3
                    await convertOpusToMp3(opusFile, filePath);
                    folderStructure = [process.env.ROOT_FOLDER_NAME, 'Audios'];
                } else if (media.mimetype.startsWith('image')) {
                    if (media.mimetype === 'image/webp') {
                        fileName = `sticker_${randomId}.webp`;
                        filePath = path.join(localDirectories.stickers, fileName);
                        folderStructure = [process.env.ROOT_FOLDER_NAME, 'Stickers'];
                    } else {
                        fileName = `image_${randomId}.jpeg`;
                        filePath = path.join(localDirectories.image, fileName);
                        folderStructure = [process.env.ROOT_FOLDER_NAME, 'Imagens'];
                    }
                    fs.writeFileSync(filePath, media.data, 'base64');
                } else if (media.mimetype.startsWith('video')) {
                    fileName = `video_${randomId}.mp4`;
                    filePath = path.join(localDirectories.video, fileName);
                    folderStructure = [process.env.ROOT_FOLDER_NAME, 'Videos'];
                    fs.writeFileSync(filePath, media.data, 'base64');
                } else if (media.mimetype === 'text/x-vcard') {
                    fileName = `contact_${randomId}.vcf`;
                    filePath = path.join(localDirectories.contacts, fileName);
                    folderStructure = [process.env.ROOT_FOLDER_NAME, 'Contatos'];
                    fs.writeFileSync(filePath, media.data, 'base64');
                } else {
                    fileName = `file_${randomId}`;
                    filePath = path.join(localDirectories.other, fileName);
                    folderStructure = [process.env.ROOT_FOLDER_NAME, 'Outros'];
                    fs.writeFileSync(filePath, media.data, 'base64');
                }

                // Upload para o Google Drive
                const driveClient = await getDriveClient();
                const uploadSuccess = await uploadToDrive(filePath, fileName, media.mimetype, driveClient, folderStructure);

                if (uploadSuccess) {
                    console.log(`Upload do arquivo ${fileName} foi bem-sucedido e o arquivo local foi removido.`);
                } else {
                    console.error(`Falha ao enviar o arquivo ${fileName} para o Google Drive.`);
                }
            }
        }
    });
});

// Inicializar o cliente
client.initialize();
