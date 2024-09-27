const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs-extra');
const path = require('path');
const { google } = require('googleapis');
const ffmpeg = require('fluent-ffmpeg');
const qrcode = require('qrcode-terminal');
const dotenv = require('dotenv');
dotenv.config();

// Diretórios locais para mídias
const localDirectories = {
    audio: process.env.LOCAL_AUDIO_DIR,
    image: process.env.LOCAL_IMAGE_DIR,
    video: process.env.LOCAL_VIDEO_DIR,
    text: process.env.LOCAL_TEXT_DIR,
    contacts: process.env.LOCAL_CONTACTS_DIR,
    stickers: process.env.LOCAL_STICKERS_DIR,
    other: process.env.LOCAL_OTHER_DIR
};

// Lista de e-mails com acesso permitido
const emailsPermitidos = process.env.EMAILS_ACESSO_PERMITIDO ? process.env.EMAILS_ACESSO_PERMITIDO.split(',') : [];

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

// Função para fazer upload para o Google Drive e conceder acesso apenas a e-mails específicos
async function uploadAndRestrictFileOnGoogleDrive(filePath, fileName, mimeType, driveClient, folderStructure) {
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

    // Faz o upload do arquivo para o Google Drive
    const response = await driveClient.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id',
    });

    if (response.data.id) {
        console.log(`Arquivo ${fileName} foi enviado ao Google Drive, ID: ${response.data.id}`);

        // Conceder permissões de leitura aos e-mails listados
        for (const email of emailsPermitidos) {
            await driveClient.permissions.create({
                fileId: response.data.id,
                requestBody: {
                    role: 'reader',
                    type: 'user',
                    emailAddress: email.trim(),
                },
            });
            console.log(`Acesso concedido ao e-mail: ${email.trim()}`);
        }

        // Após confirmação de upload e permissão bem-sucedida, remover o arquivo local
        fs.removeSync(filePath);
        console.log(`Arquivo ${filePath} foi removido do diretório local.`);
        return response.data.id;
    } else {
        console.error(`Erro ao enviar ${fileName} para o Google Drive.`);
        return false;
    }
}

// Função para converter arquivos .opus para .mp3 e remover o arquivo original
async function convertAndRemoveOriginal(sourcePath, targetPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(sourcePath)
            .toFormat('mp3')
            .on('end', () => {
                console.log(`Arquivo ${sourcePath} convertido para .mp3 e salvo em ${targetPath}`);
                fs.removeSync(sourcePath);  // Remove o arquivo original após a conversão
                console.log(`Arquivo original ${sourcePath} foi removido.`);
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
                let fileName, filePath, originalFilePath, folderStructure;

                if (media.mimetype.startsWith('audio/ogg') || media.mimetype === 'audio/opus') {
                    fileName = `audio_${randomId}.mp3`;
                    originalFilePath = path.join(localDirectories.audio, `audio_${randomId}.opus`);
                    filePath = path.join(localDirectories.audio, fileName);

                    // Salvar o arquivo .opus
                    fs.writeFileSync(originalFilePath, media.data, 'base64');
                    console.log(`Áudio .opus salvo como ${originalFilePath}`);

                    // Converter para .mp3 e remover o arquivo original .opus
                    await convertAndRemoveOriginal(originalFilePath, filePath);
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

                // Upload para o Google Drive e conceder acesso restrito aos e-mails listados
                const driveClient = await getDriveClient();
                await uploadAndRestrictFileOnGoogleDrive(filePath, fileName, media.mimetype, driveClient, folderStructure);
            }
        }
    });
});

// Inicializar o cliente
client.initialize();
