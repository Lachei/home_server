#include "util.hpp"

#include <openssl/sha.h>

constexpr std::string_view AUTH_ALG{"SHA-256"};
constexpr std::string_view AUTH_REALM{"user@minifuziserver.duckdns.org"};
static crow_status unauthorized_err(const std::string &msg = {}) {
    return crow_status{crow::status::UNAUTHORIZED, 
        crow_status::header_vec{{"WWW-Authenticate", std::format(R"(Digest algorithm="{}",nonce="{:x}",realm="{}",qop="auth")", AUTH_ALG, std::chrono::system_clock::now().time_since_epoch().count(), AUTH_REALM)}}, msg};
}
bool valid_credential(const std::string &credential, const Credentials& credentials) {
    size_t colon = credential.find_first_of(':');
    if (colon == std::string::npos || colon == credential.size() - 1)
        return false;
    std::string username = credential.substr(0, colon);
    std::string_view sha = std::string_view{credential}.substr(colon + 1);
    return sha == credentials.get_credential(username);
}
std::string cookie_extract_credential(const std::string &cookie) {
    size_t cred_offset = cookie.find("credentials");
    if (cred_offset == std::string_view::npos)
        return {};

    size_t s = cookie.find_first_not_of(" =", cred_offset + 11);
    if (s == std::string::npos)
        return {};

    size_t e = cookie.find_first_of(" ", s);
    return cookie.substr(s, e);
}
bool valid_cookie_credential(const std::string &cookie, const Credentials& credentials) {
        // check for authorization field in cookies
    return valid_credential(cookie_extract_credential(cookie), credentials);
}
std::string_view extract_word(std::string_view &content, char delim = ' ') {
	auto start_word = content.find_first_not_of(delim);
	if (start_word == std::string_view::npos) start_word = 0;
	auto end_word = content.find_first_of(delim, start_word);
	auto ret = content.substr(start_word, end_word - start_word);
	auto s = content.find_first_not_of(delim, end_word);
	if (s == std::string_view::npos)
		content = {};
	else
		content = content.substr(s);
	return ret;
}
static constexpr std::string_view HEX_CHARS{"0123456789abcdef"};
std::string to_hex_string(const std::string &s) {   
    std::string h(s.size() * 2, ' ');
    for (int i: i_range(s.size())) {
        h[i * 2] = HEX_CHARS[uint8_t(s[i]) >> 4];
        h[i * 2 + 1] = HEX_CHARS[uint8_t(s[i]) & 0xf];
    }
    return h;
}
std::string get_authorized_username(const crow::request &req, const Credentials &credentials) {
    auto cred = req.headers.find("credentials");
    if (cred != req.headers.end() && valid_credential(cred->second, credentials)) {
        return cred->second.substr(0, cred->second.find_first_of(':'));
    }

    auto auth = req.headers.find("Authorization");
    if (auth == req.headers.end())
        throw unauthorized_err("Missing authorization, header");

    // extracting auth header content
    std::string username, response, nonce, cnonce, nc, uri;
    std::string_view auth_header_content = auth->second;
    std::string_view cur = extract_word(auth_header_content);
    if (cur != "Digest")
        throw unauthorized_err("Missing Digest key word at the beginning");
    for (cur = extract_word(auth_header_content, ','); cur.size(); cur = extract_word(auth_header_content, ',')) {
        std::string_view key = extract_word(cur, '='); // now cur holds the value
        for(;key.size() && key.front() == ' '; key.remove_prefix(1));
        for(;key.size() && key.back() == ' '; key.remove_suffix(1));
        if (cur.size() && cur.front() == '"') // unquoting
            cur.remove_prefix(1);
        if (cur.size() && cur.back() == '"')
            cur.remove_suffix(1);
        if (key == "username")
            username = cur;
        else if (key == "realm") {
            if (cur != AUTH_REALM)
                throw unauthorized_err(std::format("check_authorization_header(): bad realm '{}', should be {}", cur, AUTH_REALM));
        } else if (key == "qop") {
            if (cur != "auth") 
                throw unauthorized_err(std::format("check_authorization_header(): bad qop '{}', should be auth", cur));
        } else if (key == "algorithm") {
            if (cur != AUTH_ALG)
                throw unauthorized_err(std::format("check_authorization_header(): bad alorithm '{}', should be {}", cur, AUTH_ALG));
        } else if (key == "response")
            response = cur;
        else if (key == "nonce")
            nonce = cur;
        else if (key == "cnonce")
            cnonce = cur;
        else if (key == "nc")
            nc = cur;
        else if (key == "uri")
            uri = cur;
        else
            CROW_LOG_WARNING << "check_authorization_header(): unkwnown key '"  << key << ',';
    }
    // calculate reference sha256 for digest auth according to standard digest auth: H(H(username:realm:password):nonce:nonceCount:cnonce:qop:H(method:digestURI))
    // with H(username:realm:password) is the stored password
    std::string h1 = credentials.get_credential(username);
    if (h1.empty())
        throw unauthorized_err("Username not registered" + username);
    // h2 calculation: H(method:digestURI)
    std::string h2(SHA256_DIGEST_LENGTH, ' ');
    std::string data = crow::method_name(req.method) + ':' + uri;
    SHA256((uint8_t*)data.data(), data.size(), (uint8_t*)h2.data());
    h2 = to_hex_string(h2);

    // final hash calc
    std::string response_calc(SHA256_DIGEST_LENGTH, ' ');
    data = h1 + ':' + nonce + ':' + nc + ':' + cnonce + ":auth:" + h2;
    SHA256((uint8_t*)data.data(), data.size(), (uint8_t*)response_calc.data());
    response_calc = to_hex_string(response_calc);

    if (response_calc != response)
        throw unauthorized_err(std::format("Bad response, client: {}, server: {}", response, response_calc));

    return std::string{username};
}

