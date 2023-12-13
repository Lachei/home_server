#include <iostream>
#include "crow/crow.h"

#include "Credentials.hpp"
#include "Database.hpp"
#include "database_util.hpp"
#include "data_util.hpp"

struct AccessControlHeader{
    struct context{};
    
    void before_handle(crow::request& req, crow::response& res, context& ctx){}
    void after_handle(crow::request& req, crow::response& res, context& ctx){
        // only add access control allow for login/main page
        if(req.url.find("18080") - req.url.size() <= 1) {
            res.add_header("Access-Control-Allow-Origin", "*");
            res.add_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.add_header("Access-Control-Allow-Headers", "Content-Type");
            res.add_header("Access-Control-Allow-Credentials", "true");
        }
    }
};

void print_help()
{
    std::cout << "Home server can be called with the following command line arguments:\n";
    std::cout << "    ./home_server [OptionalArgs] --data data/path\n";
    std::cout << "RequiredArgs:\n";
    std::cout << "    --data    : The directory where the data tab stores all data files\n";
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
    if (std::ranges::contains(args, "--help"sv))
        print_help();
    
    std::string_view data_base_folder = get_parameter(args, "--data");
    if (data_base_folder.empty()) {
        std::cout << "[error] Missing --data argument.\n";
        print_help();
        return -1;
    }

    crow::App<AccessControlHeader> app;
    
    Credentials credentials("credentials/cred.json");
    Database database("data/events");
    database_util::setup_event_table(database);
    database_util::setup_shift_tables(database);
    data_util::setup_data(data_base_folder);

    // ------------------------------------------------------------------------------------------------
    // Login/authentication
    // ------------------------------------------------------------------------------------------------
    const std::string main_page_text = crow::mustache::load_text("main.html");
    CROW_ROUTE(app, "/")([&main_page_text](){
        return main_page_text;
    });
    
    CROW_ROUTE(app, "/get_salt/<string>")([&credentials](const std::string& user){
        return credentials.get_user_salt(user);
    });

    CROW_ROUTE(app, "/get_create_salt/<string>")([&credentials](const std::string& user){
        // TODO: should only be doable by the admin, maybe delete functionality
        return credentials.get_or_create_user_salt(user);
    });
    
    CROW_ROUTE(app, "/change_password/<string>")([&credentials](const crow::request& req, const std::string& user){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        auto new_pwd = req.headers.find("new_pwd");
        if (new_pwd == req.headers.end() || !credentials.contains(user))
            return std::string("Missing new_pwd in header infos or user is not available");
        
        if(username != user && username != admin_name) {
            return std::string("Only admin can change password of other users");
        }
            
        bool success = credentials.set_credential(user, new_pwd->second);
        if (success)
            return std::string("success");
        else 
            return std::string("failed");
    });
    
    CROW_ROUTE(app, "/delete_user/<string>")([&credentials](const crow::request& req, const std::string& user){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);
        
        bool success = credentials.delete_credential(user);
        if (success)
            return std::string("success");
        else
            return std::string("error");
    });

    CROW_ROUTE(app, "/get_all_users")([&credentials](const crow::request& req){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        nlohmann::json ret = credentials.get_user_list();
        return ret.dump();
    });
    
    // ------------------------------------------------------------------------------------------------
    // Event creation, editing, deletion, querying
    // ------------------------------------------------------------------------------------------------
    CROW_ROUTE(app, "/get_events")([&credentials, &database](const crow::request& req){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        auto events = database_util::get_events(database, username);
        return events.dump();
    });
    CROW_ROUTE(app, "/get_event/<int>")([&credentials, &database](const crow::request& req, uint64_t event_id){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        auto event = database_util::get_event(database, username, event_id);
        return event.dump();
    });
    CROW_ROUTE(app, "/add_event").methods("POST"_method)([&credentials, &database](const crow::request& req){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);
        
        try{
            const auto& event = nlohmann::json::parse(req.body);
            const auto& creator = event["creator"].get<std::string>();
            if (creator != username && username != admin_name)
                return nlohmann::json{{"error", "can not create event for other users, only admin can do that"}}.dump();
                
            auto result = database_util::add_event(database, event);
            return result.dump();
        } catch(nlohmann::json::parse_error e){
            return nlohmann::json{{"error", e.what()}}.dump();
        }
        
        return std::string{};
    });
    CROW_ROUTE(app, "/update_event").methods("POST"_method)([&credentials, &database](const crow::request& req){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        const auto event = nlohmann::json::parse(req.body);
        const auto& creator = event["creator"].get<std::string>();
        if (creator != username && username != admin_name)
            return nlohmann::json{{"error", "can not update an event from another user, only admin can do that"}}.dump();
        
        auto result = database_util::update_event(database, event);
        return result.dump();
    });
    CROW_ROUTE(app, "/delete_event/<int>")([&credentials, &database](const crow::request& req, uint64_t id){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        const auto result = database_util::delete_event(database, username, id);
        return result.dump();
    });

    // ------------------------------------------------------------------------------------------------
    // Shift editing
    // ------------------------------------------------------------------------------------------------
    CROW_ROUTE(app, "/start_shift/<string>")([&credentials, &database](const crow::request& req, const std::string user){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        if (username != user && username != admin_name)
            return nlohmann::json{{"error", "can not begin shift for another user, only admin can do that"}}.dump();
        
        auto result = database_util::start_shift(database, user);
        return result.dump();
    });
    CROW_ROUTE(app, "/check_active_shift/<string>")([&credentials, &database](const crow::request& req, const std::string user){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        if (username != user && username != admin_name)
            return nlohmann::json{{"error", "can not check shift for another user, only admin can do that"}}.dump();
        
        auto result = database_util::check_active_shift(database, user);
        return result.dump();
    });
    CROW_ROUTE(app, "/end_shift/<string>")([&credentials, &database](const crow::request& req, const std::string& user){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        if (username != user && username != admin_name)
            return nlohmann::json{{"error", "can not end shift for another user, only admin can do that"}}.dump();
        
        const auto result = database_util::end_shift(database, user);
        return result.dump();
    });
    CROW_ROUTE(app, "/get_shifts")([&credentials, &database](const crow::request& req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        const auto res = database_util::get_shifts_grouped(database);
        return res.dump();
    });
    CROW_ROUTE(app, "/get_shift/<int>")([&credentials, &database](const crow::request& req, uint64_t shift_id) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);
        
        const auto res = database_util::get_shift(database, shift_id);
        return res.dump();
    });
    CROW_ROUTE(app, "/update_shift").methods("POST"_method)([&credentials, &database](const crow::request& req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);
        
        const auto shift = nlohmann::json::parse(req.body);
        const auto& user = shift["user"].get<std::string>();
        if (user != username && username != admin_name)
            return nlohmann::json{{"error", "can not update a shift of another person, only admin can do that"}}.dump();

        auto result = database_util::update_shift(database, shift);
        return result.dump();
    });
    CROW_ROUTE(app, "/delete_shift/<int>")([&credentials, &database](const crow::request& req, uint64_t shift_id) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);
        
        auto result = database_util::delete_shift(database, username, shift_id);
        return result.dump();
    });
    CROW_ROUTE(app, "/add_shift").methods("POST"_method)([&credentials, &database](const crow::request &req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);
        
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
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        return data_util::get_dir_infos(data_base_folder, "").dump();
    });
    CROW_ROUTE(app, "/daten/<path>")([&credentials, &data_base_folder](const crow::request &req, const std::string& path) {
        EXTRACT_CHECK_CREDENTIALS_T(req, credentials, crow::response);

        crow::response res;
        std::filesystem::path file_path = data_base_folder.data() + path;
        if (std::filesystem::exists(file_path) && !std::filesystem::is_directory(file_path))
            res.set_static_file_info(file_path.string());
        else
            res.body = data_util::get_dir_infos(data_base_folder, path).dump();

        return res;
    });
    CROW_ROUTE(app, "/upload_daten").methods("POST"_method)([&credentials, &data_base_folder](const crow::request &req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        if (req.headers.find("path") == req.headers.end())
            return nlohmann::json{{"error", "The path header is missing in the request"}}.dump();
        const auto res = data_util::write_file(data_base_folder.data() + req.headers.find("path")->second, {reinterpret_cast<const std::byte*>(req.body.data()), req.body.size()});
        return res.dump();
    });
    CROW_ROUTE(app, "/create_folder")([&credentials, &data_base_folder](const crow::request &req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        if (req.headers.find("path") == req.headers.end())
            return nlohmann::json{{"error", "The path header is missing in the request"}}.dump();
        const auto res = data_util::create_dir(data_base_folder.data() + req.headers.find("path")->second);
        return res.dump();
    });
    CROW_ROUTE(app, "/create_file")([&credentials, &data_base_folder](const crow::request &req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        if (req.headers.find("path") == req.headers.end())
            return nlohmann::json{{"error", "The path header field is missing in the reqeust"}}.dump();
        const auto res = data_util::create_file(data_base_folder.data() + req.headers.find("path")->second);
        return res.dump();
    });
    CROW_ROUTE(app, "/move_daten").methods("POST"_method)([&credentials, &data_base_folder](const crow::request &req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        const auto move_infos = nlohmann::json::parse(req.body);
        const auto res = data_util::move_files(data_base_folder, move_infos);
        return res.dump();
    });
    CROW_ROUTE(app, "/delete_daten").methods("POST"_method)([&credentials, &data_base_folder](const crow::request &req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        const auto delete_files = nlohmann::json::parse(req.body);
        const auto res = data_util::delete_files(data_base_folder, delete_files);
        return res.dump();
    });

    // ------------------------------------------------------------------------------------------------
    // File editing
    // ------------------------------------------------------------------------------------------------
    const auto tbl_editor_page = crow::mustache::load("editors/tbl.html");
    CROW_ROUTE(app, "/edit_tbl/<path>")([&credentials, &data_base_folder, &tbl_editor_page](const crow::request& req, const std::string& path) {
        EXTRACT_CHECK_CREDENTIALS_T(req, credentials, crow::response);

        if (std::filesystem::path(path).extension() != ".tbl")
            return crow::response{nlohmann::json{{"error", "Only tbl files allowed for edit_tbl route"}}.dump()};
        std::string data_path = data_base_folder.data() + path;
        std::ifstream data(data_path, std::ios_base::binary);
        std::string d; d.resize(std::filesystem::file_size(data_path));
        data.read(d.data(), d.size());
        crow::mustache::context crow_context{};
        crow_context["user_credentials"] = req.headers.find("credentials")->second; // simple copy paste
        crow_context["file_data"] = d;
        crow_context["file_name"] = std::filesystem::path(data_path).filename().string();
        crow::response r(tbl_editor_page.render_string(crow_context));
        r.add_header("Content-Type", crow::mime_types.at("html"));
        return r;
    });

    
    // ------------------------------------------------------------------------------------------------
    // General page loading
    // ------------------------------------------------------------------------------------------------
    const auto overview_page = crow::mustache::load("overview.html");
    CROW_ROUTE(app, "/overview").methods("POST"_method, "GET"_method)([&credentials, &main_page_text, &overview_page](const crow::request& req){
        EXTRACT_CREDENTIALS(req);
        
        crow::response res;
        if (!credentials.check_credential(std::string(username), sha)){
            CROW_LOG_INFO << "Credential check failed for username " << username << ':' << sha;
            return main_page_text;
        }

        bool is_admin = username == admin_name;
        using op = std::pair<std::string const, crow::json::wvalue>;
        crow::mustache::context crow_context{};
        crow_context["user_credentials"] = std::string(username) + ":" + std::string(sha);
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
    const std::string user_css = crow::mustache::load_text("user.css");
    const std::string sha_js = crow::mustache::load_text("sha256.js");
    const std::string tab_arbeitsplanung = crow::mustache::load_text("tabs/arbeitsplanung.html");
    const std::string tab_stempeluhr = crow::mustache::load_text("tabs/stempeluhr.html");
    const std::string tab_data = crow::mustache::load_text("tabs/data.html");
    const std::string tab_einstellungen = crow::mustache::load_text("tabs/einstellungen.html");
    CROW_ROUTE(app, "/admin.css")([&admin_css](){return admin_css;});
    CROW_ROUTE(app, "/user.css")([&user_css](){return user_css;});
    CROW_ROUTE(app, "/sha256.js")([&sha_js](){crow::response r(sha_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    CROW_ROUTE(app, "/tabs/arbeitsplanung.html")([&tab_arbeitsplanung](){return tab_arbeitsplanung;});
    CROW_ROUTE(app, "/tabs/stempeluhr.html")([&tab_stempeluhr](){return tab_stempeluhr;});
    CROW_ROUTE(app, "/tabs/daten.html")([&tab_data](){return tab_data;});
    CROW_ROUTE(app, "/tabs/einstellungen.html")([&tab_einstellungen](){return tab_einstellungen;});

    app.port(18080).multithreaded().run();
    return 0;
}