#include <iostream>
#include <regex>
#include "crow/crow.h"

#include "Credentials.hpp"
#include "Database.hpp"
#include "database_util.hpp"
#include "data_util.hpp"
#include "editor_util.hpp"
#include "string_split.hpp"
#include "git_util.hpp"

#define TRY(expr) try { expr; } catch (const std::exception &e) { CROW_LOG_WARNING << e.what(); }

static Credentials &credentials_singleton() {
    static Credentials credentials("credentials/cred.json");
    return credentials;
}

inline std::string_view safe_string_view(const char *c) { return c ? std::string_view{c}: std::string_view{}; }

struct AuthMiddleWare {
    struct context {
        std::string cookie_content{};
    };

    void before_handle(crow::request& req, crow::response& res, context& ctx) {
        auto login = req.headers.find("login");
        if (login != req.headers.end()) {
            req.add_header("credentials", login->second);
            if (valid_credential(login->second, credentials_singleton()))
                ctx.cookie_content = login->second;
            return;
        }

        auto cookie = req.headers.find("Cookie");
        if (cookie != req.headers.end() && valid_cookie_credential(cookie->second, credentials_singleton())) { // if credentials field is present, all done
            req.add_header("credentials", cookie_extract_credential(cookie->second));
            return;
        }

        auto authorization = req.headers.find("Authorization");
        if (authorization == req.headers.end()) // if no Authorization filed given, cannot convert to credentials
            return;
        try {
            std::string username = get_authorized_username(req, credentials_singleton());
            std::string sha = credentials_singleton().get_credential(username);
            req.add_header("credentials", username + ":" + sha);
            ctx.cookie_content = username + ":" + sha;
            return;
        } catch (...) {}
    }

    void after_handle(crow::request& req, crow::response& res, context& ctx) {
        if(ctx.cookie_content.size())
            res.add_header("Set-Cookie", "credentials=" + ctx.cookie_content + "; Max-Age=31536000; SameSite=Strict; Path=/");
    }
};

struct default_groups{
    static constexpr std::string_view unauthorized_user{"unautorisierte_benutzer"};
    static constexpr std::string_view authorized_user{"autorisierte_benutzer"};
};
struct default_users{
    static constexpr std::string_view unauthorized_user{"unautorisierter_benutzer"};
    static constexpr std::string_view authorized_user{"autorisierter_benutzer"};
};

void print_help()
{
    std::cout << "Home server can be called with the following command line arguments:\n";
    std::cout << "    ./home_server [OptionalArgs] --data data/path\n";
    std::cout << "RequiredArgs:\n";
    std::cout << "    --data     : The directory where the data tab stores all data files\n";
    std::cout << "    --databases: The directory where the databases are stored\n";
    std::cout << "    --cert     : The directory where the certificate files can be found\n";
    std::cout << "OptionalArgs:\n";
    std::cout << "    --help    : Prints this help dialogue\n";
}

std::string_view get_parameter(std::span<const char*> args, std::string_view parameter) {
    if (!std::ranges::contains(args, parameter))
        return {};
    
    auto e = std::ranges::find(args, parameter);
    if (e == args.end() || ++e == args.end())
        return {};
    
    return *e;
}

using namespace std::string_view_literals;
int main(int argc, const char** argv) {
    std::span<const char*> args(argv, argc);
    bool show_help = std::ranges::contains(args, "--help"sv);
    
    std::string data_base_folder = std::string(get_parameter(args, "--data"));
    if (data_base_folder.empty()) {
        CROW_LOG_WARNING << "Missing --data argument, setting it to 'daten/'.\n";
        show_help = true;
        data_base_folder = "daten/";
    }
    if (data_base_folder.back() != '/') {
        CROW_LOG_WARNING << "Data folder missing slash at the and, adding it automatically";
        data_base_folder += '/';
    }

    std::string_view certificates_folder = get_parameter(args, "--cert");
    if (certificates_folder.empty()) {
        CROW_LOG_WARNING << "Missing --cert argument, defaulting to data/certificates/";
        show_help = true;
        certificates_folder = "data/certification/";
    }

    std::string_view databases_folder = get_parameter(args, "--databases");
    if (databases_folder.empty()) {
        CROW_LOG_WARNING << "Missing --databases argument, defaulting to 'data/'";
        databases_folder = "data/";
    }
 
    if (show_help)
        print_help();

    crow::App<AuthMiddleWare> app{};
    app.exception_handler([](crow::response &res)->void{
        try { 
            throw; // rethrow current exception
        } catch (const crow_status &e) {
            // special handle for unauthorized error
            res = crow::response(e.status);
            for (const auto &[key, val]: e.headers)
                res.add_header(key, val);
            CROW_LOG_ERROR << "Crow status error: " << e.what();
        } catch (...) {
            crow::Router::default_exception_handler(res);
        }
    });
    
    Credentials &credentials = credentials_singleton(); 
    Database database(std::string(databases_folder) + "events");
    database_util::setup_event_table(database);
    database_util::setup_shift_tables(database);
    data_util::setup_data(data_base_folder);
    TRY(git_util::init_git(data_base_folder));
    
    std::mutex invoice_file_mutex{};

    // ------------------------------------------------------------------------------------------------
    // Login/authentication
    // ------------------------------------------------------------------------------------------------
    const std::string main_page_text = crow::mustache::load_text("main.html");
    CROW_ROUTE(app, "/")([&main_page_text](){
        // crow::response res(crow::status::UNAUTHORIZED, main_page_text);
        // res.add_header("WWW-Authenticate", "Digest realm=\"logout\"");
        return main_page_text;
    });
    
    CROW_ROUTE(app, "/login")([&credentials](const crow::request& req){
        std::string username = get_authorized_username(req, credentials);
        return "";
    });
    
    CROW_ROUTE(app, "/change_password/<string>")([&credentials](const crow::request& req, const std::string& user){
        std::string username = get_authorized_username(req, credentials);

        auto new_pwd = req.headers.find("new_pwd");
        if (new_pwd == req.headers.end())
            return crow::response{"Missing new_pwd in header infos"};

        if(username != user && username != admin_name)
            return crow::response{"Only admin can change password of other users"};

        crow::response res{crow::status::OK};

        bool success = credentials.set_credential(user, new_pwd->second);
        if (success) {
            res.body = "success";
            if (user == username) // only if the password for the issuer is changed the cookie has to be reset
                res.add_header("Set-Cookie", "credentials=" + user + ':' + new_pwd->second + "; Max-Age=31536000; SameSite=Strict; Path=/");
        } else {
            res.body = "failed";
        }
        return res;
    });

    CROW_ROUTE(app, "/delete_user/<string>")([&credentials](const crow::request& req, const std::string& user) -> crow::response{
        std::string username = get_authorized_username(req, credentials);

        if (user == admin_name)
            return crow::response{crow::status::FORBIDDEN};

        bool success = credentials.delete_credential(user);
        if (success)
            return crow::response{"success"};
        else
            return crow::response{"error"};
    });

    CROW_ROUTE(app, "/get_all_users")([&credentials](const crow::request& req) -> std::string {
        std::string username = get_authorized_username(req, credentials);

        nlohmann::json ret = credentials.get_user_list();
        return ret.dump();
    });

    // ------------------------------------------------------------------------------------------------
    // Git information
    // ------------------------------------------------------------------------------------------------
    CROW_ROUTE(app, "/git_history/<path>")([&credentials, &data_base_folder](const crow::request& req, std::string path) -> std::string {
        std::string username = get_authorized_username(req, credentials);

        return git_util::get_history_response(data_base_folder + path);
    });
    CROW_ROUTE(app, "/git_commit")([&credentials, &data_base_folder](const crow::request& req) -> std::string{
        std::string username = get_authorized_username(req, credentials);

        auto file_path = req.headers.find("file_path");
        if (file_path == req.headers.end())
            return "missing file_path";
        auto git_hash = req.headers.find("git_hash");
        if (git_hash == req.headers.end())
            return "missing git_hash";

        return git_util::get_commit(file_path->second, git_hash->second);
    });

    
    // ------------------------------------------------------------------------------------------------
    // Event creation, editing, deletion, querying
    // ------------------------------------------------------------------------------------------------
    CROW_ROUTE(app, "/get_events")([&credentials, &database](const crow::request& req) -> std::string {
        std::string username = get_authorized_username(req, credentials);

        auto events = database_util::get_events(database, username);
        return events.dump();
    });
    CROW_ROUTE(app, "/get_event/<int>")([&credentials, &database](const crow::request& req, uint64_t event_id) ->std::string {
        std::string username = get_authorized_username(req, credentials);

        auto event = database_util::get_event(database, username, event_id);
        return event.dump();
    });
    std::mutex update_cache_mutex;
    std::vector<std::pair<std::chrono::utc_clock::time_point, nlohmann::json>> update_cache;
    CROW_ROUTE(app, "/add_event").methods("POST"_method)([&credentials, &database, &update_cache, &update_cache_mutex](const crow::request& req) -> std::string {
        std::string username = get_authorized_username(req, credentials);
        
        try{
            const auto& event = nlohmann::json::parse(req.body);
            const auto& creator = event["creator"].get<std::string>();
            if (creator != username && username != admin_name)
                return nlohmann::json{{"error", "can not create event for other users, only admin can do that"}}.dump();
                
            auto result = database_util::add_event(database, event);
            {
                std::scoped_lock lock{update_cache_mutex};
                update_cache.emplace_back(std::chrono::utc_clock::now(), result);
            }
            return result.dump();
        } catch(nlohmann::json::parse_error e){
            return nlohmann::json{{"error", e.what()}}.dump();
        }
        
        return std::string{};
    });
    CROW_ROUTE(app, "/update_event").methods("POST"_method)([&credentials, &database, &update_cache, &update_cache_mutex](const crow::request& req){
        std::string username = get_authorized_username(req, credentials);

        const auto event = nlohmann::json::parse(req.body);
        const auto& creator = event["creator"].get<std::string>();
        bool user_affected = creator == username || username == admin_name;
        for (auto user: string_split{json_array_to_comma_list(event["people"].get<std::string>()), ","sv})
            if (user == username)
                user_affected = true;
        if (!user_affected)
            return nlohmann::json{{"error", "can not update an event from another user, only admin can do that"}}.dump();
        {
            std::scoped_lock lock{update_cache_mutex};
            update_cache.emplace_back(std::chrono::utc_clock::now(), event);
        }

        auto result = database_util::update_event(database, event);
        return result.dump();
    });
    CROW_ROUTE(app, "/get_updated_events")([&credentials, &update_cache, &update_cache_mutex](const crow::request& req){
        std::string username = get_authorized_username(req, credentials);
        
        // removing old entries
        nlohmann::json ret{};
        {
            std::scoped_lock lock{update_cache_mutex};
            auto p{update_cache.begin()};
            for (; p != update_cache.end() && p->first < std::chrono::utc_clock::now() - std::chrono::minutes(5); ++p);
            update_cache.erase(update_cache.begin(), p);
            for (const auto &[time, event]: update_cache)
                ret.push_back(event);
        }

        return ret.dump();
    });
    CROW_ROUTE(app, "/delete_event/<int>")([&credentials, &database](const crow::request& req, uint64_t id){
        std::string username = get_authorized_username(req, credentials);

        const auto result = database_util::delete_event(database, username, id);
        return result.dump();
    });

    // ------------------------------------------------------------------------------------------------
    // Shift editing
    // ------------------------------------------------------------------------------------------------
    CROW_ROUTE(app, "/start_shift/<string>")([&credentials, &database](const crow::request& req, const std::string user){
        std::string username = get_authorized_username(req, credentials);

        if (username != user && username != admin_name)
            return nlohmann::json{{"error", "can not begin shift for another user, only admin can do that"}}.dump();

        std::string_view comment{};
        auto comment_hdr = req.headers.find("comment");
        if (comment_hdr != req.headers.end())
            comment = comment_hdr->second;

        auto result = database_util::start_shift(database, user, comment);
        return result.dump();
    });
    CROW_ROUTE(app, "/check_active_shift/<string>")([&credentials, &database](const crow::request& req, const std::string user){
        std::string username = get_authorized_username(req, credentials);

        if (username != user && username != admin_name)
            return nlohmann::json{{"error", "can not check shift for another user, only admin can do that"}}.dump();
        
        auto result = database_util::check_active_shift(database, user);
        return result.dump();
    });
    CROW_ROUTE(app, "/end_shift/<string>")([&credentials, &database, &data_base_folder](const crow::request& req, const std::string& user){
        std::string username = get_authorized_username(req, credentials);

        if (username != user && username != admin_name)
            return nlohmann::json{{"error", "can not end shift for another user, only admin can do that"}}.dump();
        
        const auto result = database_util::end_shift(database, user);
        data_util::try_add_shift_to_rech(username, data_base_folder, std::chrono::minutes(result["shift_length"].get<int>()), result["comment"].get<std::string>());
        return result.dump();
    });
    CROW_ROUTE(app, "/get_shifts")([&credentials, &database](const crow::request& req) {
        std::string username = get_authorized_username(req, credentials);

        const auto res = database_util::get_shifts_grouped(database);
        return res.dump();
    });
    CROW_ROUTE(app, "/get_shift/<int>")([&credentials, &database](const crow::request& req, uint64_t shift_id) {
        std::string username = get_authorized_username(req, credentials);
        
        const auto res = database_util::get_shift(database, shift_id);
        return res.dump();
    });
    CROW_ROUTE(app, "/update_shift").methods("POST"_method)([&credentials, &database](const crow::request& req) {
        std::string username = get_authorized_username(req, credentials);
        
        const auto shift = nlohmann::json::parse(req.body);
        const auto& user = shift["user"].get<std::string>();
        if (user != username && username != admin_name)
            return nlohmann::json{{"error", "can not update a shift of another person, only admin can do that"}}.dump();

        auto result = database_util::update_shift(database, shift);
        return result.dump();
    });
    CROW_ROUTE(app, "/delete_shift/<int>")([&credentials, &database](const crow::request& req, uint64_t shift_id) {
        std::string username = get_authorized_username(req, credentials);
        
        auto result = database_util::delete_shift(database, username, shift_id);
        return result.dump();
    });
    CROW_ROUTE(app, "/add_shift").methods("POST"_method)([&credentials, &database](const crow::request &req) {
        std::string username = get_authorized_username(req, credentials);
        
        const auto shift = nlohmann::json::parse(req.body);
        if(shift["user"].get<std::string>() != username && username != admin_name)
            return nlohmann::json{{"error", "can not insert a shift of another user, only admin can do that"}}.dump();
            
        auto result = database_util::add_shift(database, shift);
        return result.dump();
    });
    
    // ------------------------------------------------------------------------------------------------
    // Data processing
    // ------------------------------------------------------------------------------------------------
    CROW_ROUTE(app, "/daten/")([&credentials, &data_base_folder](const crow::request &req) {
        std::string username = get_authorized_username(req, credentials);

        return data_util::get_dir_infos(data_base_folder, "").dump();
    });
    CROW_ROUTE(app, "/daten/<path>")([&credentials, &data_base_folder](const crow::request &req, const std::string& path) {
        // sanity check which avoids any .. in the path. This hinders users to get folders
        // outside of the data subfolder which would be a security violation
        if (path.find("..") != std::string::npos)
            return crow::response{"{error: \".. is not allowed in the path.\"}"};

        // fast allowed return for applications
        crow::response res;
        std::filesystem::path file_path = data_base_folder.data() + path;
        if (path.starts_with("Anwendungen/")) {
            CROW_LOG_INFO << "No user check for file " << file_path;
            if (std::filesystem::exists(file_path) && !std::filesystem::is_directory(file_path))
                res.set_static_file_info(file_path.string());
            else
                res.body = data_util::get_dir_infos(data_base_folder, path).dump();
            return res;
        }

        std::string username = get_authorized_username(req, credentials);

        if (std::filesystem::exists(file_path) && !std::filesystem::is_directory(file_path)) {
            bool raw = safe_string_view(req.url_params.get("raw")) == "true";
            bool edit = safe_string_view(req.url_params.get("edit")) == "true";
            std::string ext = file_path.extension().string();
            if (!raw && editor_util::is_extension_editor(ext))
                res = editor_util::get_editor(edit, req, path, data_base_folder);
            else
                res.set_static_file_info(file_path.string());
        }
        else
            res.body = data_util::get_dir_infos(data_base_folder, path).dump();

        return res;
    });
    CROW_ROUTE(app, "/upload_daten").methods("POST"_method)([&credentials, &data_base_folder](const crow::request &req) {
        std::string username = get_authorized_username(req, credentials);

        if (req.headers.find("path") == req.headers.end())
            return nlohmann::json{{"error", "The path header is missing in the request"}}.dump();
        const auto res = data_util::update_file(username, data_base_folder.data() + req.headers.find("path")->second, {reinterpret_cast<const std::byte*>(req.body.data()), req.body.size()});
        return res.dump();
    });
    CROW_ROUTE(app, "/create_folder")([&credentials, &data_base_folder](const crow::request &req) {
        std::string username = get_authorized_username(req, credentials);

        if (req.headers.find("path") == req.headers.end())
            return nlohmann::json{{"error", "The path header is missing in the request"}}.dump();
        const auto res = data_util::create_dir(username, data_base_folder.data() + req.headers.find("path")->second);
        return res.dump();
    });
    CROW_ROUTE(app, "/create_file")([&credentials, &data_base_folder](const crow::request &req) {
        std::string username = get_authorized_username(req, credentials);

        if (req.headers.find("path") == req.headers.end())
            return nlohmann::json{{"error", "The path header field is missing in the reqeust"}}.dump();
        const auto res = data_util::update_file(username, data_base_folder.data() + req.headers.find("path")->second);
        return res.dump();
    });
    CROW_ROUTE(app, "/update_file").methods("POST"_method)([&credentials, &data_base_folder](const crow::request &req) {
        std::string username = get_authorized_username(req, credentials);

        if (req.headers.find("path") == req.headers.end())
            return nlohmann::json{{"error", "The path header field is missing in the reqeust"}}.dump();
        std::string base_revision{};
        if (req.headers.contains("revision"))
            base_revision = req.headers.find("revision")->second;
        const auto res = data_util::update_file(username, data_base_folder.data() + req.headers.find("path")->second, {reinterpret_cast<const std::byte*>(req.body.data()), req.body.size()}, base_revision);
        return res.dump();
    });
    CROW_ROUTE(app, "/check_file_revision")([&credentials, &data_base_folder](const crow::request &req) {
        std::string username = get_authorized_username(req, credentials);

        if (!req.headers.contains("path"))
            return nlohmann::json{{"error", "The path header field is missing in the reqeust"}}.dump();
        if (!req.headers.contains("revision"))
            return nlohmann::json{{"error", "The path revision field is missing in the reqeust"}}.dump();

        std::string path{data_base_folder + req.headers.find("path")->second};
        std::string client_revision{req.headers.find("revision")->second};
        
        return data_util::check_file_revision(path, client_revision);
    });
    CROW_ROUTE(app, "/move_daten").methods("POST"_method)([&credentials, &data_base_folder](const crow::request &req) {
        std::string username = get_authorized_username(req, credentials);

        const auto move_infos = nlohmann::json::parse(req.body);
        const auto res = data_util::move_files(username, data_base_folder, move_infos);
        return res.dump();
    });
    CROW_ROUTE(app, "/delete_daten").methods("POST"_method)([&credentials, &data_base_folder](const crow::request &req) {
        std::string username = get_authorized_username(req, credentials);

        const auto delete_files = nlohmann::json::parse(req.body);
        const auto res = data_util::delete_files(username, data_base_folder, delete_files);
        return res.dump();
    });
    
    CROW_ROUTE(app, "/create_rech")([&credentials, &data_base_folder, &invoice_file_mutex](const crow::request &req) {
        std::string username = get_authorized_username(req, credentials);

        if (req.headers.find("path") == req.headers.end())
            return nlohmann::json{{"error", "The path header field is missing in the reqeust"}}.dump();
        
        // atomically increment the invoice cache id
        const std::string invoice_cache_path = std::string(data_base_folder) + "rechnungs_cache.json";
        nlohmann::json invoice_cache{};
        nlohmann::json invoice{};
        {
            std::scoped_lock lock(invoice_file_mutex);
            std::ifstream invoice_cache_file(invoice_cache_path);
            try {
                invoice_cache = nlohmann::json::parse(invoice_cache_file);
                if (!invoice_cache.contains("cur_id"))
                    invoice_cache["cur_id"] = int(1);
            } catch (...) {
                invoice_cache= nlohmann::json{{"cur_id", 0}};
            };
            invoice_cache["cur_id"] = invoice_cache["cur_id"].get<int>() + 1;
            invoice["id"] = invoice_cache["cur_id"].get<int>();
            std::ofstream invoice_cache_out(invoice_cache_path);
            invoice_cache_out << invoice_cache.dump();
        }
        const std::string file_data = invoice.dump();

        const auto res = data_util::update_file(username, data_base_folder.data() + req.headers.find("path")->second, {reinterpret_cast<const std::byte*>(file_data.data()), file_data.size()});
        return res.dump();
    });
    
    // ------------------------------------------------------------------------------------------------
    // Map loading (read only and currently does not need authentication)
    // ------------------------------------------------------------------------------------------------
    CROW_ROUTE(app, "/heightmap/meta")([](const crow::request& req) {
        // the tiles are already string encoded for faster processing
        // on the website side)
        static nlohmann::json meta = [](){  // single instantiate on first call
            std::vector<std::string> tiles{};
            if (!std::filesystem::exists("data/tiles"))
                return nlohmann::json{{"tiles", std::move(tiles)}};
            for (const auto& dir_entry: std::filesystem::recursive_directory_iterator("data/tiles")) {
                if (dir_entry.is_regular_file() && dir_entry.path().extension() == ".png") {
                    // finding the 2 last / from the back
                    const std::string tmp = dir_entry.path().string();
                    std::string_view string_view = tmp;
                    string_view = string_view.substr(0, string_view.find_last_of("."));
                    int slash_count = 0;
                    auto c = string_view.end() - 1;
                    for (; c >= string_view.begin(); --c) {
                        if (*c == '/') ++slash_count;
                        if (slash_count >= 3) break;
                    }
                    tiles.emplace_back(c + 1, string_view.end());
                }
            }
            return nlohmann::json{{"tiles", std::move(tiles)}};
        }();

        crow::response res{meta.dump()};
        return res;
    });
    CROW_ROUTE(app, "/heightmap/<path>")([](const crow::request& req, const std::string& tile) {
        std::string filepath = "data/tiles/" + tile + ".png";
        if (!std::filesystem::exists(filepath))
            return crow::response{404, "{error: \"The heightmap could not be found\"}"};

        crow::response res;
        res.set_static_file_info(filepath);
        return res;
    });

    // ------------------------------------------------------------------------------------------------
    // File editing
    // ------------------------------------------------------------------------------------------------
    CROW_ROUTE(app, "/edit_tbl/<path>")([&credentials, &data_base_folder](const crow::request& req, const std::string& path) {
        std::string username = get_authorized_username(req, credentials);

        return editor_util::get_editor(true, req, path, data_base_folder);
    });
    CROW_ROUTE(app, "/edit_md/<path>")([&credentials, &data_base_folder](const crow::request& req, const std::string& path) {
        std::string username = get_authorized_username(req, credentials);
        
        return editor_util::get_editor(true, req, path, data_base_folder);
    });
    CROW_ROUTE(app, "/edit_rech/<path>")([&credentials, &data_base_folder](const crow::request& req, const std::string& path) {
        std::string username = get_authorized_username(req, credentials);
        
        return editor_util::get_editor(true, req, path, data_base_folder, username);
    });
    CROW_ROUTE(app, "/edit_gpx/<path>")([&credentials, &data_base_folder](const crow::request& req, const std::string& path) {
        std::string username = get_authorized_username(req, credentials);
        
        return editor_util::get_editor(true, req, path, data_base_folder);
    });
    CROW_ROUTE(app, "/edit_gpx")([&credentials, &data_base_folder](const crow::request& req) {
        // EXTRACT_CHECK_CREDENTIALS_T(req, credentials, crow::response);
        
        return editor_util::get_editor(true, req, "test.gpx", data_base_folder);
    });
    
    // ------------------------------------------------------------------------------------------------
    // General page loading
    // ------------------------------------------------------------------------------------------------
    const auto overview_page = crow::mustache::load("overview.html");
    CROW_ROUTE(app, "/overview")([&credentials, &main_page_text, &overview_page](const crow::request& req){
        std::string username = get_authorized_username(req, credentials);

        bool is_admin = username == admin_name;
        crow::mustache::context crow_context{};
        if (is_admin) {
            crow_context["benutzername"] = "admin";
            crow_context["user_specific_css"] = "admin.css";
            return overview_page.render_string(crow_context);
        }
        else {
            crow_context["benutzername"] = std::string(username);
            crow_context["user_specific_css"] = "user.css";
            return overview_page.render_string(crow_context);
        }
    });
    
    const std::string admin_css = crow::mustache::load_text("admin.css");
    CROW_ROUTE(app, "/admin.css")([&admin_css](){return admin_css;});
    const std::string md_css = crow::mustache::load_text("editors/md_default.css");
    CROW_ROUTE(app, "/md_default.css")([&md_css](){return md_css;});
    const std::string user_css = crow::mustache::load_text("user.css");
    CROW_ROUTE(app, "/user.css")([&user_css](){return user_css;});
    const std::string drawdown_js = crow::mustache::load_text("drawdown.js");
    CROW_ROUTE(app, "/drawdown.js")([&drawdown_js](){crow::response r(drawdown_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string katex_js = crow::mustache::load_text("katex.js");
    CROW_ROUTE(app, "/katex.js")([&katex_js](){crow::response r(katex_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string ling_alg_js = crow::mustache::load_text("lin_alg.js");
    CROW_ROUTE(app, "/lin_alg.js")([&ling_alg_js](){crow::response r(ling_alg_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string virtual_texture_js = crow::mustache::load_text("virtual_texture.js");
    CROW_ROUTE(app, "/virtual_texture.js")([&virtual_texture_js](){crow::response r(virtual_texture_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string qr_js = crow::mustache::load_text("qrcode.min.js");
    CROW_ROUTE(app, "/qrcode.min.js")([&qr_js](){crow::response r(qr_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string canvas_renderer_js = crow::mustache::load_text("stl_viewer/CanvasRenderer.js");
    CROW_ROUTE(app, "/CanvasRenderer.js")([&canvas_renderer_js](){crow::response r(canvas_renderer_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string orbit_controls_js = crow::mustache::load_text("stl_viewer/OrbitControls.js");
    CROW_ROUTE(app, "/OrbitControls.js")([&orbit_controls_js](){crow::response r(orbit_controls_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string projector_js = crow::mustache::load_text("stl_viewer/Projector.js");
    CROW_ROUTE(app, "/Projector.js")([&projector_js](){crow::response r(projector_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string trackball_controls_js = crow::mustache::load_text("stl_viewer/TrackballControls.js");
    CROW_ROUTE(app, "/TrackballControls.min.js")([&trackball_controls_js](){crow::response r(trackball_controls_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string load_stl_js = crow::mustache::load_text("stl_viewer/load_stl.min.js");
    CROW_ROUTE(app, "/load_stl.min.js")([&load_stl_js](){crow::response r(load_stl_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string parser_js = crow::mustache::load_text("stl_viewer/parser.min.js");
    CROW_ROUTE(app, "/parser.min.js")([&parser_js](){crow::response r(parser_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string stl_viewer_js = crow::mustache::load_text("stl_viewer/stl_viewer.min.js");
    CROW_ROUTE(app, "/stl_viewer.min.js")([&stl_viewer_js](){crow::response r(stl_viewer_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string three_js = crow::mustache::load_text("stl_viewer/three.min.js");
    CROW_ROUTE(app, "/three.min.js")([&three_js](){crow::response r(three_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string webgl_detector_js = crow::mustache::load_text("stl_viewer/webgl_detector.js");
    CROW_ROUTE(app, "/webgl_detector.js")([&webgl_detector_js](){crow::response r(webgl_detector_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});

    const std::string tab_arbeitsplanung = crow::mustache::load_text("tabs/arbeitsplanung.html");
    CROW_ROUTE(app, "/tabs/arbeitsplanung.html")([&tab_arbeitsplanung](){return tab_arbeitsplanung;});
    const std::string tab_stempeluhr = crow::mustache::load_text("tabs/stempeluhr.html");
    CROW_ROUTE(app, "/tabs/stempeluhr.html")([&tab_stempeluhr](){return tab_stempeluhr;});
    const std::string tab_data = crow::mustache::load_text("tabs/data.html");
    CROW_ROUTE(app, "/tabs/daten.html")([&tab_data](){return tab_data;});
    const std::string tab_einstellungen = crow::mustache::load_text("tabs/einstellungen.html");
    CROW_ROUTE(app, "/tabs/einstellungen.html")([&tab_einstellungen](){return tab_einstellungen;});
    CROW_ROUTE(app, "/favicon.ico")([]{ crow::response res; res.set_static_file_info("templates/server_logo.png"); return res; });
    
    // checking the certificates folder
#ifdef CROW_ENABLE_SSL
    if (std::filesystem::exists(std::string(certificates_folder) + "/cert.pem") &&
        std::filesystem::exists(std::string(certificates_folder) + "/privkey.pem"))
        app.ssl_file(std::string(certificates_folder) + "/cert.pem",
                     std::string(certificates_folder) + "/privkey.pem");
    else if (std::filesystem::exists(std::string(certificates_folder) + "/rsa.key") &&
             std::filesystem::exists(std::string(certificates_folder) + "/rsa.cert"))
        app.ssl_file(std::string(certificates_folder) + "/rsa.cert", 
                     std::string(certificates_folder) + "/rsa.key");
    else if (std::filesystem::exists(std::string(certificates_folder) + "/rsa.pem"))
        app.ssl_file(std::string(certificates_folder) + "/rsa.pem");
    else {
        std::cout << "[error] Could not find the certificates files in the given"
                     "certificates folder: " << certificates_folder << ". Starting sever without certs\n";
    }
#endif
    
    if (!credentials.contains(std::string{admin_name})){
        std::cout << "[error] Missing admin credentials, add with the set_password.sh script\n";
        return -1;
    }

    app.port(12345).multithreaded().run();
    return 0;
}
